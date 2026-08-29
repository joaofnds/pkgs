import { setTimeout as sleep } from "node:timers/promises";
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
import { beforeEach, describe, expect, it } from "vitest";
import { ConsumerStall } from "../src/consumer-stall";
import { isNoGroupError } from "../src/errors";
import { RecordingBrokerProbe } from "../src/test-support/recording-broker-probe";
import { ThrowingBrokerProbe } from "../src/test-support/throwing-broker-probe";
import { BrokerHarness, REDIS_URL } from "./support/harness";

const NOOP_HANDLER: EventHandler = { async handle() {} };
const NAMESPACE = "svc";
const STALL_WINDOW = 6000;

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

class StallTimeline extends RecordingBrokerProbe {
	readonly stalledAt: number[] = [];

	consumerStalled(stall: ConsumerStall): void {
		super.consumerStalled(stall);
		this.stalledAt.push(Date.now());
	}
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const gapBefore = (times: number[], nth: number): number =>
	times[nth - 1] - times[nth - 2];

describe("BrokerProbe wiring", () => {
	let probe: RecordingBrokerProbe;

	beforeEach(() => {
		probe = new RecordingBrokerProbe();
	});

	async function start(
		overrides: Parameters<typeof BrokerHarness.start>[0] = {},
	): Promise<BrokerHarness> {
		return BrokerHarness.start(overrides, probe);
	}

	it("reports connected once the broker connects", async () => {
		await using _harness = await start();

		expect(probe.connectedCount).toBe(1);
	});

	it("reports the number of messages reclaimed in a pass", async () => {
		await using harness = await start({
			reclaim: {
				interval: 50,
				minIdleTime: 50,
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

	it("reports no reclaim for a consumer with nothing pending", async () => {
		await using harness = await start();
		const topic = uniqueTopic();
		const deliveries = new Deliveries();
		await harness.broker.consume(subscription(topic, "h"), deliveries.deliver);

		await harness.broker.publish(new Topic(topic), encode("acked"));
		await waitFor(() => deliveries.messages.length === 1);
		await sleep(300);

		expect(probe.reclaimedCounts).toEqual([]);
	});

	it("reports a failing reclaim turn instead of dropping it into the read catch", async () => {
		await using harness = await BrokerHarness.start();
		await harness.maint.sendCommand([
			"ACL",
			"SETUSER",
			"claimless",
			"on",
			">pw",
			"~*",
			"+@all",
			"-xautoclaim",
		]);
		const claimless = await BrokerHarness.start(
			{ redis: { url: "redis://claimless:pw@localhost:6381" } },
			probe,
		);

		try {
			const topic = uniqueTopic();
			const deliveries = new Deliveries();
			deliveries.mode = "nack";
			await claimless.broker.consume(
				subscription(topic, "h"),
				deliveries.deliver,
			);

			await claimless.broker.publish(new Topic(topic), encode("stuck"));
			await waitFor(() => probe.reclaimFailures.length > 0, {
				message: "a denied XAUTOCLAIM should surface as a reclaim failure",
			});

			await claimless.broker.publish(new Topic(topic), encode("after"));
			await waitFor(() => deliveries.messages.length === 2, {
				message: "the loop should reach its fresh read after a failed claim",
			});
			expect(probe.consumerStoppedCalls).toEqual([]);
		} finally {
			await claimless.stop();
			await harness.maint.sendCommand(["ACL", "DELUSER", "claimless"]);
		}
	});

	it("paces a read that keeps failing and reports it as a consumer stall", async () => {
		await using harness = await BrokerHarness.start();
		await harness.maint.sendCommand([
			"ACL",
			"SETUSER",
			"readless",
			"on",
			">pw",
			"~*",
			"+@all",
			"-xreadgroup",
		]);
		const timeline = new StallTimeline();
		const readless = await BrokerHarness.start(
			{
				redis: { url: "redis://readless:pw@localhost:6381" },
				readTimeout: 2000,
			},
			timeline,
		);

		try {
			const startedAt = Date.now();
			await readless.broker.consume(
				subscription(uniqueTopic(), "h"),
				new Deliveries().deliver,
			);

			await waitFor(() => timeline.stalledAt.length >= 4, {
				message: "a denied XREADGROUP should surface as a consumer stall",
			});
			await sleep(STALL_WINDOW - (Date.now() - startedAt));

			const first = timeline.consumerStalledCalls[0];
			expect(first.consecutive).toBe(2);
			expect(String(first.error)).toContain("NOPERM");
			expect(timeline.consumerStalledCalls.length).toBeLessThanOrEqual(6);
			expect(gapBefore(timeline.stalledAt, 4)).toBeGreaterThanOrEqual(
				gapBefore(timeline.stalledAt, 2) + 300,
			);
		} finally {
			await readless.stop();
			await harness.maint.sendCommand(["ACL", "DELUSER", "readless"]);
		}
	});

	it("restarts the stall count once a read succeeds again", async () => {
		await using harness = await BrokerHarness.start();
		const deny = ["ACL", "SETUSER", "readless", "on", ">pw", "~*", "+@all"];
		await harness.maint.sendCommand([...deny, "-xreadgroup"]);
		const timeline = new StallTimeline();
		const readless = await BrokerHarness.start(
			{ redis: { url: "redis://readless:pw@localhost:6381" } },
			timeline,
		);

		try {
			const topic = uniqueTopic();
			const deliveries = new Deliveries();
			await readless.broker.consume(
				subscription(topic, "h"),
				deliveries.deliver,
			);
			await waitFor(() => timeline.stalledAt.length >= 2, {
				message: "a denied XREADGROUP should surface as a consumer stall",
			});

			await harness.maint.sendCommand(deny);
			await readless.broker.publish(new Topic(topic), encode("restored"));
			await waitFor(() => deliveries.messages.length === 1, {
				message: "the loop should deliver again once the ACL is restored",
			});
			const beforeRelapse = timeline.consumerStalledCalls.length;
			await harness.maint.sendCommand([...deny, "-xreadgroup"]);
			await waitFor(
				() => timeline.consumerStalledCalls.length > beforeRelapse,
				{ message: "revoking XREADGROUP again should surface a fresh stall" },
			);

			expect(timeline.consumerStalledCalls[beforeRelapse].consecutive).toBe(2);
		} finally {
			await readless.stop();
			await harness.maint.sendCommand(["ACL", "DELUSER", "readless"]);
		}
	});

	it("reports neither a reclaim failure nor a stop for a consumer that was stopped", async () => {
		await using harness = await start();
		const topic = uniqueTopic();
		const running = await harness.broker.consume(
			subscription(topic, "h"),
			new Deliveries().deliver,
		);

		await running.stop();
		await sleep(300);

		expect(probe.reclaimFailures).toEqual([]);
		expect(probe.consumerStoppedCalls).toEqual([]);
	});

	it("survives a killed connection and resumes delivering", async () => {
		await using harness = await start({
			redis: { url: REDIS_URL, name: "flume-victim" },
		});
		const topic = uniqueTopic();
		const deliveries = new Deliveries();
		await harness.broker.consume(subscription(topic, "h"), deliveries.deliver);
		await harness.broker.publish(new Topic(topic), encode("before"));
		await waitFor(() => deliveries.messages.length === 1);

		expect(await harness.killNamedClients("flume-victim")).toBeGreaterThan(0);

		await waitFor(
			() => probe.disconnectedCount >= 1 && probe.reconnectedCount >= 1,
			{ message: "a killed write client should reconnect through the lifecycle" },
		);
		await harness.broker.publish(new Topic(topic), encode("after"));
		await waitFor(() => deliveries.messages.length === 2, {
			message: "delivery should resume once the clients are back",
		});
	});

	it("reports the groups destroyed by the reaper", async () => {
		await using harness = await start({
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
		expect(probe.reapedCalls[0].streamsTrimmed).toBe(0);
	});

	it("reports a reaper failure instead of dropping it", async () => {
		await using harness = await start({
			reaper: { interval: 40, trim: false },
		});
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
		await using hostile = await BrokerHarness.start(
			{
				reclaim: {
					interval: 50,
					minIdleTime: 50,
					throughputThreshold: 1_000_000,
				},
			},
			new ThrowingBrokerProbe(),
		);
		const topic = uniqueTopic();
		const deliveries = new Deliveries();
		await hostile.broker.consume(subscription(topic, "h"), deliveries.deliver);

		await hostile.broker.publish(new Topic(topic), encode("hi"));

		await waitFor(() => deliveries.messages.length === 1, {
			message: "a throwing broker probe must not break delivery",
		});
	});

	it("stops a consumer's read loop without busy-spinning when its group is destroyed", async () => {
		await using harness = await start();
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
		await using harness = await start();
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
