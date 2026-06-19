import { setTimeout as sleep } from "node:timers/promises";
import {
	DeliveredMessage,
	DeliveryMode,
	EventHandler,
	RetryPolicy,
	StartFrom,
	Subscription,
	Topic,
} from "@joaofnds/flume";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RedisStreamsBroker } from "../src/index";
import { BrokerHarness } from "./support/harness";
import { uniqueTopic, waitFor } from "./support/wait";

const NOOP_HANDLER: EventHandler = { async handle() {} };

function subscription(
	topic: string,
	name: string,
	options: { delivery?: DeliveryMode; startFrom?: StartFrom } = {},
): Subscription {
	return new Subscription({
		topic: new Topic(topic),
		name,
		handler: NOOP_HANDLER,
		retry: new RetryPolicy({ maxAttempts: 3 }),
		delivery: options.delivery ?? DeliveryMode.Competing,
		startFrom: options.startFrom,
	});
}

class Deliveries {
	readonly messages: DeliveredMessage[] = [];
	mode: "ack" | "nack" = "ack";

	deliver = async (msg: DeliveredMessage): Promise<void> => {
		this.messages.push(msg);
		if (this.mode === "ack") await msg.ack();
		else await msg.nack();
	};

	bodies(): string[] {
		return this.messages.map((m) => new TextDecoder().decode(m.body));
	}
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("RedisStreamsBroker", () => {
	let harness: BrokerHarness;
	let broker: RedisStreamsBroker;

	beforeEach(async () => {
		harness = await BrokerHarness.start();
		broker = harness.broker;
	});

	afterEach(async () => {
		await harness.stop();
	});

	it("delivers a freshly published message with deliveryCount 1", async () => {
		const topic = uniqueTopic();
		const deliveries = new Deliveries();
		await broker.consume(subscription(topic, "h"), deliveries.deliver);

		await broker.publish(new Topic(topic), encode("hello"));

		await waitFor(() => deliveries.messages.length === 1);
		expect(deliveries.messages[0].deliveryCount).toBe(1);
		expect(deliveries.bodies()).toEqual(["hello"]);
	});

	it("round-trips a non-UTF-8 payload without corruption", async () => {
		const topic = uniqueTopic();
		const payload = new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0xfd, 0x80]);
		const deliveries = new Deliveries();
		await broker.consume(subscription(topic, "h"), deliveries.deliver);

		await broker.publish(new Topic(topic), payload);

		await waitFor(() => deliveries.messages.length === 1);
		expect(Array.from(deliveries.messages[0].body)).toEqual(
			Array.from(payload),
		);
	});

	it("removes an acked message from the pending set", async () => {
		const topic = uniqueTopic();
		const deliveries = new Deliveries();
		await broker.consume(subscription(topic, "h"), deliveries.deliver);

		await broker.publish(new Topic(topic), encode("once"));
		await waitFor(() => deliveries.messages.length === 1);

		const id = deliveries.messages[0].id;
		await waitFor(
			async () => (await harness.pendingCount(topic, "flume:h", id)) === 0,
			{ message: "acked message should leave the PEL" },
		);
	});

	it("leaves a nacked message pending and reclaim redelivers it with an incremented count", async () => {
		const topic = uniqueTopic();
		const deliveries = new Deliveries();
		deliveries.mode = "nack";
		await broker.consume(subscription(topic, "h"), deliveries.deliver);

		await broker.publish(new Topic(topic), encode("retry-me"));

		await waitFor(() => deliveries.messages.length >= 2, {
			message: "reclaim should redeliver the nacked message",
		});
		expect(deliveries.messages[0].deliveryCount).toBe(1);
		expect(deliveries.messages[1].deliveryCount).toBe(2);
		expect(deliveries.messages[0].id).toBe(deliveries.messages[1].id);
	});

	it("reclaims the entire backlog when it exceeds the reclaim count", async () => {
		const small = await BrokerHarness.start({
			reclaim: {
				interval: 50,
				minIdleTime: 50,
				count: 5,
				throughputThreshold: 1_000_000,
			},
		});
		try {
			const topic = uniqueTopic();
			const deliveries = new Deliveries();
			deliveries.mode = "nack";
			await small.broker.consume(subscription(topic, "h"), deliveries.deliver);

			const backlog = 12;
			for (let i = 0; i < backlog; i++) {
				await small.broker.publish(new Topic(topic), encode(`m${i}`));
			}

			const redeliveredIds = (): Set<string> =>
				new Set(
					deliveries.messages
						.filter((m) => m.deliveryCount >= 2)
						.map((m) => m.id),
				);
			await waitFor(() => redeliveredIds().size === backlog, {
				message: "every nacked message in the backlog should be reclaimed",
			});
		} finally {
			await small.stop();
		}
	});

	it("does not deliver events published before a startFrom:new subscription", async () => {
		const topic = uniqueTopic();
		await broker.publish(new Topic(topic), encode("old"));

		const deliveries = new Deliveries();
		await broker.consume(
			subscription(topic, "h", { startFrom: "new" }),
			deliveries.deliver,
		);
		await broker.publish(new Topic(topic), encode("new"));

		await waitFor(() => deliveries.messages.length === 1);
		expect(deliveries.bodies()).toEqual(["new"]);
	});

	it("replays events published before a startFrom:beginning subscription", async () => {
		const topic = uniqueTopic();
		await broker.publish(new Topic(topic), encode("old"));

		const deliveries = new Deliveries();
		await broker.consume(
			subscription(topic, "h", { startFrom: "beginning" }),
			deliveries.deliver,
		);

		await waitFor(() => deliveries.bodies().includes("old"));
	});

	it("does not reclaim while local throughput is above the gate threshold", async () => {
		const gated = await BrokerHarness.start({
			reclaim: {
				interval: 50,
				minIdleTime: 50,
				count: 100,
				throughputThreshold: 0,
			},
		});
		try {
			const topic = uniqueTopic();
			const deliveries = new Deliveries();
			deliveries.mode = "nack";
			await gated.broker.consume(subscription(topic, "h"), deliveries.deliver);

			await gated.broker.publish(new Topic(topic), encode("stuck"));
			await waitFor(() => deliveries.messages.length === 1);

			await sleep(300);
			expect(deliveries.messages).toHaveLength(1);
		} finally {
			await gated.stop();
		}
	});

	it("splits work across competing consumers (distinct instances) in the same group", async () => {
		const instanceB = await BrokerHarness.start({ consumerName: "instance-b" });
		try {
			const topic = uniqueTopic();
			const a = new Deliveries();
			const b = new Deliveries();
			await broker.consume(subscription(topic, "shared"), a.deliver);
			await instanceB.broker.consume(subscription(topic, "shared"), b.deliver);

			for (let i = 0; i < 4; i++) {
				await broker.publish(new Topic(topic), encode(`m${i}`));
			}

			await waitFor(() => a.messages.length + b.messages.length === 4, {
				message: "all four messages should be delivered once across the group",
			});
			const ids = [...a.messages, ...b.messages].map((m) => m.id);
			expect(new Set(ids).size).toBe(4);
		} finally {
			await instanceB.stop();
		}
	});
});
