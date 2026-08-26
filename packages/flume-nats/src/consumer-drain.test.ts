import { Topic } from "@joaofnds/flume";
import { JsMsg } from "@nats-io/jetstream";
import { beforeEach, describe, expect, it } from "vitest";
import { ConsumerDrain } from "./consumer-drain";
import { subjectFor } from "./subject";
import { RecordingBrokerProbe } from "./test-support/recording-broker-probe";

const TOPIC = new Topic("orders");
const DURABLE = "orders__workers";
const CONCURRENCY = 10;

function message(seq: number): JsMsg {
	return {
		seq,
		data: new Uint8Array([seq]),
		info: { deliveryCount: 1 },
		ack: () => {},
		nak: async () => true,
	} as unknown as JsMsg;
}

async function* sourceOf(...messages: JsMsg[]): AsyncIterable<JsMsg> {
	for (const msg of messages) yield msg;
}

async function* sourceFailingWith(
	error: unknown,
	...messages: JsMsg[]
): AsyncIterable<JsMsg> {
	for (const msg of messages) yield msg;
	throw error;
}

describe(ConsumerDrain, () => {
	let probe: RecordingBrokerProbe;

	beforeEach(() => {
		probe = new RecordingBrokerProbe();
	});

	it("delivers every message from the source in order", async () => {
		const delivered: string[] = [];

		await new ConsumerDrain(probe, CONCURRENCY).drain(
			sourceOf(message(1), message(2)),
			TOPIC,
			DURABLE,
			async (msg) => {
				delivered.push(msg.id);
			},
		);

		expect(delivered).toEqual(["1", "2"]);
		expect(probe.deliveryFailures).toEqual([]);
	});

	it("reports every failed delivery and keeps draining", async () => {
		await new ConsumerDrain(probe, CONCURRENCY).drain(
			sourceOf(message(1), message(2)),
			TOPIC,
			DURABLE,
			async () => {
				throw new Error("deliver boom");
			},
		);

		expect(probe.deliveryFailures).toHaveLength(2);
		expect(probe.consumerStoppedCalls).toEqual([]);
	});

	it("reports a source failure as a consumer stop", async () => {
		const failure = new Error("permission violation");

		await new ConsumerDrain(probe, CONCURRENCY).drain(
			sourceFailingWith(failure, message(1)),
			TOPIC,
			DURABLE,
			async () => {},
		);

		expect(probe.consumerStoppedCalls).toEqual([
			{ subject: subjectFor(TOPIC.name), durable: DURABLE, error: failure },
		]);
	});
});
