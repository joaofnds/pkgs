import { beforeEach, describe, expect, it } from "vitest";
import {
	DeliveryMode,
	GuardedProbe,
	RetryPolicy,
	Subscription,
	Topic,
} from "../index";
import { RecordingHandler } from "../test-support/recording-handler";
import { ThrowingProbe } from "../test-support/throwing-probe";
import { FakeBroker } from "../testing/fake-broker";
import { FakeProbe } from "../testing/fake-probe";

describe(GuardedProbe, () => {
	const topic = new Topic("user.created");
	const sub = new Subscription({
		topic,
		name: "send-email",
		handler: new RecordingHandler(),
		retry: new RetryPolicy({ maxAttempts: 1 }),
		delivery: DeliveryMode.Competing,
	});
	let delegate: FakeProbe;
	let probe: GuardedProbe;

	beforeEach(() => {
		delegate = new FakeProbe();
		probe = new GuardedProbe(delegate);
	});

	async function message() {
		const broker = new FakeBroker();
		await broker.consume(sub, async () => {});
		return broker.deliverFresh(sub, { id: "1", body: new Uint8Array() });
	}

	it("forwards every call to the delegate", async () => {
		const msg = await message();

		probe.dispatched(topic);
		probe.processed(sub, msg);
		probe.failed(sub, msg, new Error("boom"));
		probe.deadLettered(sub, msg);

		expect(delegate.dispatchedTopics).toHaveLength(1);
		expect(delegate.processedCalls).toHaveLength(1);
		expect(delegate.failedCalls).toHaveLength(1);
		expect(delegate.deadLetteredCalls).toHaveLength(1);
	});

	it("swallows errors thrown by the delegate", async () => {
		const throwing = new GuardedProbe(new ThrowingProbe());
		const msg = await message();

		expect(() => throwing.dispatched(topic)).not.toThrow();
		expect(() => throwing.processed(sub, msg)).not.toThrow();
		expect(() => throwing.failed(sub, msg, new Error("boom"))).not.toThrow();
		expect(() => throwing.deadLettered(sub, msg)).not.toThrow();
	});
});
