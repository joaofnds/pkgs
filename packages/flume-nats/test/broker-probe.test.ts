import {
	DeliveredMessage,
	DeliveryMode,
	RetryPolicy,
	Subscription,
	Topic,
} from "@joaofnds/flume";
import { uniqueTopic, waitFor } from "@joaofnds/flume-tck";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrokerProbe, NatsStreamsBroker } from "../src/index";
import { RecordingBrokerProbe } from "../src/test-support/recording-broker-probe";
import { ThrowingBrokerProbe } from "../src/test-support/throwing-broker-probe";

const NATS_URL = "nats://localhost:4223";

function subscription(topic: string, name: string): Subscription {
	return new Subscription({
		topic: new Topic(topic),
		name,
		handler: { async handle() {} },
		retry: new RetryPolicy({ maxAttempts: 3 }),
		delivery: DeliveryMode.Competing,
	});
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("BrokerProbe wiring", () => {
	const open: NatsStreamsBroker[] = [];
	let probe: RecordingBrokerProbe;

	beforeEach(() => {
		probe = new RecordingBrokerProbe();
	});

	afterEach(async () => {
		await Promise.all(open.splice(0).map((broker) => broker.close()));
	});

	async function start(
		brokerProbe: BrokerProbe = probe,
	): Promise<NatsStreamsBroker> {
		const broker = new NatsStreamsBroker(
			{ nats: { servers: NATS_URL }, ackWait: 2000 },
			brokerProbe,
		);
		await broker.connect();
		open.push(broker);
		return broker;
	}

	it("reports connected once the broker connects", async () => {
		await start();

		expect(probe.connectedCount).toBe(1);
	});

	it("reports a delivery failure instead of dropping it", async () => {
		const broker = await start();
		const topic = uniqueTopic();
		await broker.consume(subscription(topic, "h"), async () => {
			throw new Error("deliver boom");
		});

		await broker.publish(new Topic(topic), encode("hi"));

		await waitFor(() => probe.deliveryFailures.length > 0, {
			message: "a failing delivery should surface via the probe",
		});
	});

	it("keeps delivering messages when the broker probe throws", async () => {
		const broker = await start(new ThrowingBrokerProbe());
		const topic = uniqueTopic();
		const received: DeliveredMessage[] = [];
		await broker.consume(subscription(topic, "h"), async (msg) => {
			received.push(msg);
			await msg.ack();
		});

		await broker.publish(new Topic(topic), encode("hi"));

		await waitFor(() => received.length === 1, {
			message: "a throwing broker probe must not break delivery",
		});
	});
});
