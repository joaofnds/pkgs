import { beforeEach, describe, expect, it } from "vitest";
import { Dispatcher, Envelope, JsonCodec, type Probe, Topic } from "../index";
import { ThrowingProbe } from "../test-support/throwing-probe";
import { FakeBroker } from "../testing/fake-broker";
import { FakeClock } from "../testing/fake-clock";
import { FakeProbe } from "../testing/fake-probe";

describe(Dispatcher, () => {
	const topic = new Topic("user.created");
	let broker: FakeBroker;
	let codec: JsonCodec;
	let clock: FakeClock;
	let probe: FakeProbe;

	beforeEach(() => {
		broker = new FakeBroker();
		codec = new JsonCodec();
		clock = new FakeClock(new Date("2026-06-18T12:00:00.000Z"));
		probe = new FakeProbe();
	});

	function dispatcher(withProbe: Probe = probe): Dispatcher {
		return new Dispatcher(broker, codec, clock, withProbe);
	}

	it("publishes a framed envelope carrying the encoded payload", async () => {
		await dispatcher().dispatch(topic, { userId: "123" });

		expect(broker.published).toHaveLength(1);
		const envelope = Envelope.parse(broker.published[0].body);
		expect(codec.decode(envelope.payload)).toEqual({ userId: "123" });
		expect(broker.published[0].topic.name).toBe("user.created");
	});

	it("stamps dispatchedAt from the injected clock", async () => {
		await dispatcher().dispatch(topic, { userId: "123" });

		const envelope = Envelope.parse(broker.published[0].body);
		expect(envelope.dispatchedAt).toEqual(new Date("2026-06-18T12:00:00.000Z"));
	});

	it("reports the dispatch to the probe", async () => {
		await dispatcher().dispatch(topic, { userId: "123" });

		expect(probe.dispatchedTopics).toHaveLength(1);
		expect(probe.dispatchedTopics[0].name).toBe("user.created");
	});

	it("resolves after a successful publish even when the probe throws", async () => {
		await expect(
			dispatcher(new ThrowingProbe()).dispatch(topic, { userId: "123" }),
		).resolves.toBeUndefined();
		expect(broker.published).toHaveLength(1);
	});

	it("publishes before reporting the dispatch to the probe", async () => {
		let publishedWhenProbed = -1;
		const recordingProbe: Probe = {
			dispatched: () => {
				publishedWhenProbed = broker.published.length;
			},
			processed: () => {},
			failed: () => {},
			deadLettered: () => {},
		};

		await dispatcher(recordingProbe).dispatch(topic, { userId: "123" });

		expect(publishedWhenProbed).toBe(1);
	});
});
