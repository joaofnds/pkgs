import {
	DeadLetter,
	Flume,
	JsonCodec,
	RetryPolicy,
	SystemClock,
	Topic,
} from "@joaofnds/flume";
import { FakeProbe, RecordingHandler } from "@joaofnds/flume/testing";
import { uniqueTopic, waitFor } from "@joaofnds/flume-tck";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrokerNotConnectedError, RedisStreamsBroker } from "../src/index";
import { BrokerHarness, REDIS_URL } from "./support/harness";

// Adapter-specific: the SISMEMBER idempotency gate and its {redriven, skipped}
// accounting are Redis mechanics. The portable redrive behavior (re-publish so
// the handler reprocesses; report zero on an empty stream) lives in the contract
// suite (conformance.test.ts via @joaofnds/flume-tck).

const NAMESPACE = "svc";

describe("dead-letter redrive (Redis-specific idempotency)", () => {
	let harness: BrokerHarness;
	let broker: RedisStreamsBroker;

	beforeEach(async () => {
		harness = await BrokerHarness.start();
		broker = harness.broker;
	});

	afterEach(async () => {
		await harness.stop();
	});

	const deadStream = (topic: string) => `${topic}:dead:${NAMESPACE}:flaky`;

	it("round-trips a non-UTF-8 body back onto the live topic", async () => {
		const topic = uniqueTopic();
		const body = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0xfd, 0x80]);
		const frame = new DeadLetter({ originalId: "1-0", body }).toBytes();
		await harness.maint.xAdd(deadStream(topic), "*", {
			payload: Buffer.from(frame),
		});

		const result = await broker.redriveDeadLetters({
			topic: new Topic(topic),
			name: `${NAMESPACE}:flaky`,
		});

		expect(result).toEqual({ redriven: 1, skipped: 0 });
		const entries = await harness.entries(topic);
		expect(entries).toHaveLength(1);
		expect(entries[0].payload).toEqual(body);
	});

	it("refuses a redrive on a broker that was never connected", async () => {
		const unconnected = new RedisStreamsBroker({ redis: { url: REDIS_URL } });

		await expect(
			unconnected.redriveDeadLetters({
				topic: new Topic(uniqueTopic()),
				name: `${NAMESPACE}:flaky`,
			}),
		).rejects.toBeInstanceOf(BrokerNotConnectedError);
	});

	it("is idempotent on originalId — a second redrive drives nothing", async () => {
		const topic = uniqueTopic();
		const handler = new RecordingHandler();
		handler.shouldFail = true;
		const flume = new Flume({
			namespace: NAMESPACE,
			broker,
			codec: new JsonCodec(),
			clock: new SystemClock(),
			probe: new FakeProbe(),
		});
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
});
