import {
	Flume,
	JsonCodec,
	RetryPolicy,
	SystemClock,
	Topic,
} from "@joaofnds/flume";
import { FakeProbe, RecordingHandler } from "@joaofnds/flume/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RedisStreamsBroker } from "../src/index";
import { BrokerHarness } from "./support/harness";
import { uniqueTopic, waitFor } from "./support/wait";

const NAMESPACE = "svc";

describe("dead-letter redrive over Redis", () => {
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

	const deadStream = (topic: string) => `${topic}:dead:${NAMESPACE}:flaky`;

	it("re-publishes a dead-lettered message so the handler reprocesses it", async () => {
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
			async () => (await harness.streamLength(deadStream(topic))) > 0,
			{
				message: "the failing handler should dead-letter",
			},
		);
		expect(handler.events).toHaveLength(1);

		handler.shouldFail = false;
		const result = await broker.redriveDeadLetters({
			topic: new Topic(topic),
			name: `${NAMESPACE}:flaky`,
		});

		expect(result).toEqual({ redriven: 1, skipped: 0 });
		await waitFor(() => handler.events.length === 2, {
			message: "the handler should reprocess the redriven message",
		});
		expect(handler.events[0].payload).toEqual({ n: 1 });
		expect(handler.events[1].payload).toEqual({ n: 1 });
	});

	it("is idempotent on originalId — a second redrive drives nothing", async () => {
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
			async () => (await harness.streamLength(deadStream(topic))) > 0,
		);

		handler.shouldFail = false;
		await broker.redriveDeadLetters({
			topic: new Topic(topic),
			name: `${NAMESPACE}:flaky`,
		});
		await waitFor(() => handler.events.length === 2);

		const second = await broker.redriveDeadLetters({
			topic: new Topic(topic),
			name: `${NAMESPACE}:flaky`,
		});

		expect(second).toEqual({ redriven: 0, skipped: 1 });
		expect(handler.events).toHaveLength(2);
	});

	it("reports zero on an empty or absent dead stream", async () => {
		const topic = uniqueTopic();
		const result = await broker.redriveDeadLetters({
			topic: new Topic(topic),
			name: `${NAMESPACE}:flaky`,
		});

		expect(result).toEqual({ redriven: 0, skipped: 0 });
	});
});
