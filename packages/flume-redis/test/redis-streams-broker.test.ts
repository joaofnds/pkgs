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
import { Throughput, Ticker } from "@joaofnds/throughput";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrokerAlreadyConnectedError, RedisStreamsBroker } from "../src/index";
import { RecordingBrokerProbe } from "../src/test-support/recording-broker-probe";
import { BrokerHarness } from "./support/harness";

// Adapter-specific behaviors that assert Redis Streams internals — the PEL, the
// read loop's reclaim turn and its cursor, the throughput gate. The cross-adapter port contract
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

class FakeTicker implements Ticker {
	stopped = false;

	start(): void {}

	stop(): void {
		this.stopped = true;
	}
}

class FakeTickers {
	readonly built: FakeTicker[] = [];

	next = (): FakeTicker => {
		const ticker = new FakeTicker();
		this.built.push(ticker);
		return ticker;
	};
}

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

	it("redelivers a nacked message from the consumer's read loop", async () => {
		const topic = uniqueTopic();
		const deliveries = new Deliveries();
		deliveries.mode = "nack";
		await broker.consume(subscription(topic, "h"), deliveries.deliver);

		await broker.publish(new Topic(topic), encode("stuck"));

		await waitFor(() => deliveries.messages.some((m) => m.deliveryCount >= 2), {
			message: "a nacked message should come back through the read loop",
		});
	});

	it("redelivers a backlog larger than one claim page without re-claiming the head", async () => {
		await using paged = await BrokerHarness.start({ readCount: 5 });

		const topic = uniqueTopic();
		const deliveries = new Deliveries();
		deliveries.mode = "nack";
		await paged.broker.consume(subscription(topic, "h"), deliveries.deliver);

		const backlog = 12;
		for (let i = 0; i < backlog; i++) {
			await paged.broker.publish(new Topic(topic), encode(`m${i}`));
		}

		const redeliveredIds = (): Set<string> =>
			new Set(
				deliveries.messages
					.filter((m) => m.deliveryCount >= 2)
					.map((m) => m.id),
			);
		await waitFor(() => redeliveredIds().size === backlog, {
			message: "every nacked message in the backlog should be redelivered",
		});
	});

	it("takes at most one reclaim turn per reclaim.interval", async () => {
		await using spaced = await BrokerHarness.start({
			reclaim: {
				interval: 60_000,
				minIdleTime: 50,
				throughputThreshold: 1_000_000,
			},
		});

		const topic = uniqueTopic();
		const deliveries = new Deliveries();
		deliveries.mode = "nack";
		await spaced.broker.consume(subscription(topic, "h"), deliveries.deliver);

		await spaced.broker.publish(new Topic(topic), encode("stuck"));
		await waitFor(() => deliveries.messages.length === 1);

		await sleep(300);
		expect(deliveries.messages).toHaveLength(1);
	});

	it("does not reclaim while local throughput is above the gate threshold", async () => {
		await using gated = await BrokerHarness.start({
			reclaim: {
				interval: 50,
				minIdleTime: 50,
				throughputThreshold: 0,
			},
		});

		const topic = uniqueTopic();
		const deliveries = new Deliveries();
		deliveries.mode = "nack";
		await gated.broker.consume(subscription(topic, "h"), deliveries.deliver);

		await gated.broker.publish(new Topic(topic), encode("stuck"));
		await waitFor(() => deliveries.messages.length === 1);

		await sleep(300);
		expect(deliveries.messages).toHaveLength(1);
	});

	it("resumes reclaiming once throughput falls back under the threshold", async () => {
		await using gated = await BrokerHarness.start(
			{
				reclaim: {
					interval: 50,
					minIdleTime: 50,
					throughputThreshold: 1,
				},
			},
			undefined,
			() => new Throughput(2, 50),
		);

		const topic = uniqueTopic();
		const deliveries = new Deliveries();
		deliveries.mode = "nack";
		await gated.broker.consume(subscription(topic, "h"), deliveries.deliver);

		const burst = 5;
		for (let i = 0; i < burst; i++) {
			await gated.broker.publish(new Topic(topic), encode(`m${i}`));
		}
		await waitFor(() => deliveries.messages.length === burst);

		await waitFor(() => deliveries.messages.some((m) => m.deliveryCount >= 2), {
			message: "reclaim should resume once the throughput window rolls over",
		});
	});

	it("reclaims for an idle consumer while a peer consumer is hot", async () => {
		await using peers = await BrokerHarness.start({
			reclaim: { interval: 50, minIdleTime: 100, throughputThreshold: 1 },
		});

		const hotTopic = uniqueTopic();
		const idleTopic = uniqueTopic();
		const hot = new Deliveries();
		const idle = new Deliveries();
		idle.mode = "nack";
		await peers.broker.consume(subscription(hotTopic, "hot"), hot.deliver);
		await peers.broker.consume(subscription(idleTopic, "idle"), idle.deliver);

		const burst = 100;
		for (let i = 0; i < burst; i++) {
			await peers.broker.publish(new Topic(hotTopic), encode(`m${i}`));
		}
		await waitFor(() => hot.messages.length === burst);
		await waitFor(
			async () =>
				(await peers.broker.sampleSaturation()).throughputPerSecond > 1,
			{ message: "the hot consumer should push the gauge past the threshold" },
		);
		await peers.broker.publish(new Topic(idleTopic), encode("stuck"));
		await waitFor(() => idle.messages.length === 1);

		await waitFor(() => idle.messages.some((m) => m.deliveryCount >= 2), {
			timeout: 8000,
			message: "an idle consumer should redeliver while a peer is hot",
		});
	});

	it("builds one throughput for the broker gauge and one for each consumer", async () => {
		const tickers = new FakeTickers();
		await using own = await BrokerHarness.start(
			{},
			undefined,
			() => new Throughput(60, 1000, tickers.next()),
		);

		await own.broker.consume(
			subscription(uniqueTopic(), "h"),
			new Deliveries().deliver,
		);

		expect(tickers.built).toHaveLength(2);
	});

	it("stops only the NOGROUP-stopped consumer's own throughput timer", async () => {
		const probe = new RecordingBrokerProbe();
		const tickers = new FakeTickers();
		await using own = await BrokerHarness.start(
			{},
			probe,
			() => new Throughput(60, 1000, tickers.next()),
		);
		const topic = uniqueTopic();
		await own.broker.consume(
			subscription(topic, "h"),
			new Deliveries().deliver,
		);

		await own.destroyConsumerGroup(topic, "flume:h");
		await waitFor(() => probe.consumerStoppedCalls.length >= 1, {
			message: "destroying a live consumer's group should stop the consumer",
		});

		expect(tickers.built[1].stopped).toBe(true);
		expect(tickers.built[0].stopped).toBe(false);
	});

	it("leaves both throughput timers alone when a stopped consumer is stopped again", async () => {
		const probe = new RecordingBrokerProbe();
		const tickers = new FakeTickers();
		await using own = await BrokerHarness.start(
			{},
			probe,
			() => new Throughput(60, 1000, tickers.next()),
		);
		const topic = uniqueTopic();
		const running = await own.broker.consume(
			subscription(topic, "h"),
			new Deliveries().deliver,
		);
		await own.destroyConsumerGroup(topic, "flume:h");
		await waitFor(() => probe.consumerStoppedCalls.length >= 1);

		await running.stop();

		expect(tickers.built[1].stopped).toBe(true);
		expect(tickers.built[0].stopped).toBe(false);
	});

	describe("connect", () => {
		it("refuses a second connect and leaves the first connection usable", async () => {
			const topic = uniqueTopic();
			const deliveries = new Deliveries();
			await broker.consume(subscription(topic, "h"), deliveries.deliver);

			await expect(broker.connect()).rejects.toBeInstanceOf(
				BrokerAlreadyConnectedError,
			);

			await broker.publish(new Topic(topic), encode("after the refusal"));
			await waitFor(() => deliveries.messages.length === 1, {
				message: "the refused connect should leave the first connection intact",
			});
		});

		it("resets its clients when the connection fails, so a retry is not refused", async () => {
			const unreachable = new RedisStreamsBroker({
				redis: {
					url: "redis://localhost:6399",
					socket: { reconnectStrategy: false },
				},
			});

			await expect(unreachable.connect()).rejects.toThrow();

			await expect(unreachable.connect()).rejects.not.toBeInstanceOf(
				BrokerAlreadyConnectedError,
			);
		});
	});
});
