import {
	Flume,
	JsonCodec,
	RetryPolicy,
	SystemClock,
	Topic,
} from "@joaofnds/flume";
import { FakeProbe, RecordingHandler } from "@joaofnds/flume/testing";
import { uniqueTopic, waitFor } from "@joaofnds/flume-tck";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RedisStreamsBroker } from "../src/index";
import { BrokerHarness } from "./support/harness";

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
