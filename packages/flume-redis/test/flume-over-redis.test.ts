import {
	DeadLetter,
	Flume,
	JsonCodec,
	RetryPolicy,
	SystemClock,
} from "@joaofnds/flume";
import { FakeProbe, RecordingHandler } from "@joaofnds/flume/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RedisStreamsBroker } from "../src/index";
import { BrokerHarness } from "./support/harness";
import { uniqueTopic, waitFor } from "./support/wait";

const NAMESPACE = "svc";

describe("Flume over Redis Streams", () => {
	let harness: BrokerHarness;
	let broker: RedisStreamsBroker;

	beforeEach(async () => {
		harness = await BrokerHarness.start();
		broker = harness.broker;
	});

	afterEach(async () => {
		await harness.stop();
	});

	function flumeWith(): Flume {
		return new Flume({
			namespace: NAMESPACE,
			broker,
			codec: new JsonCodec(),
			clock: new SystemClock(),
			probe: new FakeProbe(),
		});
	}

	const group = (name: string) => `flume:${NAMESPACE}:${name}`;
	const deadStream = (topic: string, name: string) =>
		`${topic}:dead:${NAMESPACE}:${name}`;

	it("processes a published event exactly once", async () => {
		const topic = uniqueTopic();
		const handler = new RecordingHandler();
		const flume = flumeWith();
		flume.on(topic, "consume", handler, {
			retry: new RetryPolicy({ maxAttempts: 3 }),
		});
		await flume.start();

		await flume.emit(topic, { hello: "world" });

		await waitFor(() => handler.events.length === 1);
		expect(handler.events[0].payload).toEqual({ hello: "world" });
		expect(handler.events[0].deliveryCount).toBe(1);

		const id = handler.events[0].id;
		await waitFor(
			async () =>
				(await harness.pendingCount(topic, group("consume"), id)) === 0,
			{ message: "a processed event should be acked, not redelivered" },
		);
		expect(handler.events).toHaveLength(1);
	});

	it("invokes a failing handler exactly maxAttempts=1 time then dead-letters", async () => {
		const topic = uniqueTopic();
		const handler = new RecordingHandler();
		handler.shouldFail = true;
		const flume = flumeWith();
		flume.on(topic, "flaky", handler, {
			retry: new RetryPolicy({ maxAttempts: 1 }),
		});
		await flume.start();

		await flume.emit(topic, { n: 1 });

		await waitFor(
			async () => (await harness.streamLength(deadStream(topic, "flaky"))) > 0,
			{ message: "exhausted handler should dead-letter" },
		);
		expect(handler.events).toHaveLength(1);
	});

	it("invokes a failing handler exactly maxAttempts=2 times then dead-letters with the original id", async () => {
		const topic = uniqueTopic();
		const handler = new RecordingHandler();
		handler.shouldFail = true;
		const flume = flumeWith();
		flume.on(topic, "flaky", handler, {
			retry: new RetryPolicy({ maxAttempts: 2 }),
		});
		await flume.start();

		await flume.emit(topic, { n: 2 });

		await waitFor(() => handler.events.length === 2, {
			message: "fresh delivery + one reclaim should invoke the handler twice",
		});
		await waitFor(
			async () => (await harness.streamLength(deadStream(topic, "flaky"))) > 0,
		);

		const originalId = handler.events[0].id;
		const dead = await harness.entries(deadStream(topic, "flaky"));
		expect(dead).toHaveLength(1);
		expect(DeadLetter.parse(dead[0].payload).originalId).toBe(originalId);

		await waitFor(
			async () =>
				(await harness.pendingCount(topic, group("flaky"), originalId)) === 0,
		);
		expect(handler.events).toHaveLength(2);
	});

	it("dead-letters a failing handler without affecting an independent handler on the same topic", async () => {
		const topic = uniqueTopic();
		const healthy = new RecordingHandler();
		const failing = new RecordingHandler();
		failing.shouldFail = true;

		const flume = flumeWith();
		flume.on(topic, "healthy", healthy, {
			retry: new RetryPolicy({ maxAttempts: 1 }),
		});
		flume.on(topic, "failing", failing, {
			retry: new RetryPolicy({ maxAttempts: 1 }),
		});
		await flume.start();

		await flume.emit(topic, { shared: true });

		await waitFor(() => healthy.events.length === 1);
		await waitFor(
			async () =>
				(await harness.streamLength(deadStream(topic, "failing"))) > 0,
		);

		expect(healthy.events[0].payload).toEqual({ shared: true });
		expect(await harness.streamLength(deadStream(topic, "healthy"))).toBe(0);
	});
});
