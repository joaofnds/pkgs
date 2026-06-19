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
import { uniqueTopic, waitFor } from "@joaofnds/flume-tck";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RedisStreamsBroker } from "../src/index";
import { BrokerHarness } from "./support/harness";

// Adapter-specific behaviors that assert Redis Streams internals — the PEL, the
// reclaim cursor sweep, the throughput gate. The cross-adapter port contract
// (delivery, retry, dead-letter, competing, broadcast, startFrom) lives in
// conformance.test.ts via @joaofnds/flume-tck and is not duplicated here.

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
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("RedisStreamsBroker (Redis-specific mechanics)", () => {
	let harness: BrokerHarness;
	let broker: RedisStreamsBroker;

	beforeEach(async () => {
		harness = await BrokerHarness.start();
		broker = harness.broker;
	});

	afterEach(async () => {
		await harness.stop();
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
});
