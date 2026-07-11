import {
	DeliveredMessage,
	DeliveryMode,
	EventHandler,
	Flume,
	JsonCodec,
	RetryPolicy,
	StartFrom,
	Subscription,
	SystemClock,
	Topic,
} from "@joaofnds/flume";
import { FakeProbe, RecordingHandler } from "@joaofnds/flume/testing";
import { uniqueTopic, waitFor } from "@joaofnds/flume-tck";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isNoGroupError } from "../src/errors";
import { RecordingBrokerProbe } from "../src/test-support/recording-broker-probe";
import { ThrowingBrokerProbe } from "../src/test-support/throwing-broker-probe";
import { BrokerHarness } from "./support/harness";

const NOOP_HANDLER: EventHandler = { async handle() {} };
const NAMESPACE = "svc";

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

describe("BrokerProbe wiring", () => {
	const open: BrokerHarness[] = [];
	let probe: RecordingBrokerProbe;

	beforeEach(() => {
		probe = new RecordingBrokerProbe();
	});

	afterEach(async () => {
		await Promise.all(open.splice(0).map((harness) => harness.stop()));
	});

	async function start(
		overrides: Parameters<typeof BrokerHarness.start>[0] = {},
	): Promise<BrokerHarness> {
		const harness = await BrokerHarness.start(overrides, probe);
		open.push(harness);
		return harness;
	}

	it("reports connected once the broker connects", async () => {
		await start();

		expect(probe.connectedCount).toBe(1);
	});

	it("reports the number of messages reclaimed in a pass", async () => {
		const harness = await start({
			reclaim: {
				interval: 50,
				minIdleTime: 50,
				count: 100,
				throughputThreshold: 1_000_000,
			},
		});
		const topic = uniqueTopic();
		const deliveries = new Deliveries();
		deliveries.mode = "nack";
		await harness.broker.consume(subscription(topic, "h"), deliveries.deliver);

		const backlog = 6;
		for (let i = 0; i < backlog; i++) {
			await harness.broker.publish(new Topic(topic), encode(`m${i}`));
		}

		await waitFor(
			() => probe.reclaimedCounts.reduce((sum, n) => sum + n, 0) >= backlog,
			{ message: "the probe should observe the reclaimed backlog" },
		);
		expect(probe.reclaimedCounts.every((n) => n > 0)).toBe(true);
	});

	it("reports the groups destroyed by the reaper", async () => {
		const harness = await start({
			broadcast: { heartbeatInterval: 25, heartbeatTtl: 100 },
			reaper: { interval: 40, trim: false },
		});
		const topic = uniqueTopic();
		await harness.broker.consume(
			subscription(topic, "cache", { delivery: DeliveryMode.Broadcast }),
			new Deliveries().deliver,
		);
		await harness.seedOrphanBroadcastGroup(topic, "flume:cache:dead-inst");

		await waitFor(() => probe.reapedCalls.length > 0, {
			message: "the probe should observe the reaper destroying the orphan",
		});
		expect(probe.reapedCalls[0].groupsDestroyed).toBeGreaterThanOrEqual(1);
	});

	it("reports a reaper failure instead of dropping it", async () => {
		const harness = await start({ reaper: { interval: 40, trim: false } });
		const topic = uniqueTopic();
		await harness.broker.consume(
			subscription(topic, "h"),
			new Deliveries().deliver,
		);

		await harness.corruptBroadcastRegistry(topic);

		await waitFor(() => probe.reapFailures.length > 0, {
			message:
				"a reaper hitting a corrupt registry key should surface via the probe",
		});
	});

	it("keeps delivering messages when the broker probe throws", async () => {
		const hostile = await BrokerHarness.start(
			{
				reclaim: {
					interval: 50,
					minIdleTime: 50,
					count: 100,
					throughputThreshold: 1_000_000,
				},
			},
			new ThrowingBrokerProbe(),
		);
		open.push(hostile);
		const topic = uniqueTopic();
		const deliveries = new Deliveries();
		await hostile.broker.consume(subscription(topic, "h"), deliveries.deliver);

		await hostile.broker.publish(new Topic(topic), encode("hi"));

		await waitFor(() => deliveries.messages.length === 1, {
			message: "a throwing broker probe must not break delivery",
		});
	});

	it("stops a consumer's read loop without busy-spinning when its group is destroyed", async () => {
		const harness = await start();
		const topic = uniqueTopic();
		const group = "flume:h";
		await harness.broker.consume(
			subscription(topic, "h"),
			new Deliveries().deliver,
		);

		await harness.destroyConsumerGroup(topic, group);

		await waitFor(() => probe.consumerStoppedCalls.length >= 1, {
			message:
				"destroying a live consumer's group should surface via the probe",
		});

		const surfaced = probe.consumerStoppedCalls[0];
		expect(surfaced.stream).toBe(topic);
		expect(surfaced.group).toBe(group);
		expect(isNoGroupError(surfaced.error)).toBe(true);

		const observed = probe.consumerStoppedCalls.length;
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(probe.consumerStoppedCalls.length).toBe(observed);
	});

	it("reports the result of a dead-letter redrive", async () => {
		const harness = await start();
		const topic = uniqueTopic();
		const handler = new RecordingHandler();
		handler.shouldFail = true;
		const flume = new Flume({
			namespace: NAMESPACE,
			broker: harness.broker,
			codec: new JsonCodec(),
			clock: new SystemClock(),
			probe: new FakeProbe(),
		});
		flume.on(topic, "flaky", handler, {
			retry: new RetryPolicy({ maxAttempts: 1 }),
		});
		await flume.start();

		await flume.emit(topic, { n: 1 });
		const deadStream = `${topic}:dead:${NAMESPACE}:flaky`;
		await waitFor(async () => (await harness.streamLength(deadStream)) > 0);

		handler.shouldFail = false;
		await harness.broker.redriveDeadLetters({
			topic: new Topic(topic),
			name: `${NAMESPACE}:flaky`,
		});

		expect(probe.redroveResults).toEqual([{ redriven: 1, skipped: 0 }]);
	});
});
