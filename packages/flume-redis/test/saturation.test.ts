import { setTimeout as sleep } from "node:timers/promises";
import {
	DeliveredMessage,
	DeliveryMode,
	EventHandler,
	RetryPolicy,
	Subscription,
	Topic,
} from "@joaofnds/flume";
import { uniqueTopic, waitFor } from "@joaofnds/flume-tck";
import { Throughput } from "@joaofnds/throughput";
import { describe, expect, it } from "vitest";
import { BrokerSaturation } from "../src/index";
import { BrokerHarness } from "./support/harness";

const NOOP_HANDLER: EventHandler = { async handle() {} };

function subscription(
	topic: string,
	name: string,
	delivery: DeliveryMode = DeliveryMode.Competing,
): Subscription {
	return new Subscription({
		topic: new Topic(topic),
		name,
		handler: NOOP_HANDLER,
		retry: new RetryPolicy({ maxAttempts: 3 }),
		delivery,
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

function snapshotFor(
	saturation: BrokerSaturation,
	stream: string,
	group: string,
) {
	return saturation.consumers.find(
		(c) => c.stream === stream && c.group === group,
	);
}

describe("saturation gauges", () => {
	async function start(throughput?: () => Throughput): Promise<BrokerHarness> {
		return BrokerHarness.start({}, undefined, throughput);
	}

	it("reports stream depth with no pending once every message is acked", async () => {
		await using harness = await start();
		const topic = uniqueTopic();
		const deliveries = new Deliveries();
		await harness.broker.consume(subscription(topic, "h"), deliveries.deliver);

		for (let i = 0; i < 4; i++) {
			await harness.broker.publish(new Topic(topic), encode(`m${i}`));
		}
		await waitFor(() => deliveries.messages.length === 4);

		const snapshot = snapshotFor(
			await harness.broker.sampleSaturation(),
			topic,
			"flume:h",
		);
		expect(snapshot).toEqual({
			stream: topic,
			group: "flume:h",
			streamDepth: 4,
			pendingCount: 0,
			consumerLag: 0,
			throughputPerSecond: expect.any(Number),
		});
	});

	it("reports the pending count while messages stay unacked", async () => {
		await using harness = await start();
		const topic = uniqueTopic();
		const deliveries = new Deliveries();
		deliveries.mode = "nack";
		await harness.broker.consume(subscription(topic, "h"), deliveries.deliver);

		for (let i = 0; i < 3; i++) {
			await harness.broker.publish(new Topic(topic), encode(`m${i}`));
		}
		await waitFor(() => deliveries.messages.length === 3);

		const snapshot = snapshotFor(
			await harness.broker.sampleSaturation(),
			topic,
			"flume:h",
		);
		expect(snapshot?.streamDepth).toBe(3);
		expect(snapshot?.pendingCount).toBe(3);
	});

	it("counts a heartbeat sweep skipped when the interval is shorter than a round trip", async () => {
		await using harness = await BrokerHarness.start({
			broadcast: { heartbeatInterval: 1, heartbeatTtl: 30_000 },
		});
		const topic = uniqueTopic();
		await harness.broker.consume(
			subscription(topic, "cache", DeliveryMode.Broadcast),
			new Deliveries().deliver,
		);

		await waitFor(
			async () =>
				(await harness.broker.sampleSaturation()).heartbeatSweepsSkipped > 0,
			{
				message:
					"a heartbeat sweep outrunning its interval should count a skipped tick",
			},
		);
	});

	it("counts a reap sweep skipped when the interval is shorter than a sweep", async () => {
		await using harness = await BrokerHarness.start({
			reaper: { interval: 1, trim: false },
		});
		const topic = uniqueTopic();
		await harness.broker.consume(
			subscription(topic, "cache", DeliveryMode.Broadcast),
			new Deliveries().deliver,
		);

		await waitFor(
			async () =>
				(await harness.broker.sampleSaturation()).reapSweepsSkipped > 0,
			{
				message:
					"a reap sweep outrunning its interval should count a skipped tick",
			},
		);
	});

	it("reports local throughput per second after deliveries", async () => {
		await using harness = await start(() => new Throughput(20, 25));
		const topic = uniqueTopic();
		const deliveries = new Deliveries();
		await harness.broker.consume(subscription(topic, "h"), deliveries.deliver);

		for (let i = 0; i < 5; i++) {
			await harness.broker.publish(new Topic(topic), encode(`m${i}`));
		}
		await waitFor(() => deliveries.messages.length === 5);

		await waitFor(
			async () =>
				(await harness.broker.sampleSaturation()).throughputPerSecond > 0,
			{ message: "throughput should reflect the delivered messages" },
		);
	});

	it("reports a different throughput for a hot and an idle consumer", async () => {
		await using harness = await start();
		const hotTopic = uniqueTopic();
		const idleTopic = uniqueTopic();
		const drained = new Deliveries();
		await harness.broker.consume(
			subscription(hotTopic, "hot"),
			drained.deliver,
		);
		await harness.broker.consume(
			subscription(idleTopic, "idle"),
			new Deliveries().deliver,
		);
		for (let i = 0; i < 100; i++) {
			await harness.broker.publish(new Topic(hotTopic), encode(`m${i}`));
		}
		await waitFor(() => drained.messages.length === 100);
		await waitFor(
			async () =>
				(snapshotFor(
					await harness.broker.sampleSaturation(),
					hotTopic,
					"flume:hot",
				)?.throughputPerSecond ?? 0) > 0,
			{ message: "the draining consumer's throughput should rise above zero" },
		);

		const saturation = await harness.broker.sampleSaturation();

		expect(
			snapshotFor(saturation, hotTopic, "flume:hot")?.throughputPerSecond,
		).toBeGreaterThan(0);
		expect(
			snapshotFor(saturation, idleTopic, "flume:idle")?.throughputPerSecond,
		).toBe(0);
	});

	it("counts only a redelivering consumer's fresh reads as throughput", async () => {
		await using harness = await BrokerHarness.start({
			reclaim: {
				interval: 50,
				minIdleTime: 100,
				throughputThreshold: 1_000_000,
			},
		});
		const topic = uniqueTopic();
		const deliveries = new Deliveries();
		deliveries.mode = "nack";
		await harness.broker.consume(subscription(topic, "h"), deliveries.deliver);

		await harness.broker.publish(new Topic(topic), encode("stuck"));
		await waitFor(() => deliveries.messages.some((m) => m.deliveryCount >= 6), {
			message: "one fresh read and five redeliveries should land",
		});
		await waitFor(
			async () =>
				(snapshotFor(await harness.broker.sampleSaturation(), topic, "flume:h")
					?.throughputPerSecond ?? 0) > 0,
			{ message: "the fresh read should reach a probe slot" },
		);
		await sleep(1100);

		const snapshot = snapshotFor(
			await harness.broker.sampleSaturation(),
			topic,
			"flume:h",
		);

		expect(snapshot?.throughputPerSecond).toBeLessThan(0.05);
	});
});
