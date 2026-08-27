import {
	DeliveredMessage,
	DeliveryMode,
	RetryPolicy,
	Subscription,
	Topic,
} from "@joaofnds/flume";
import { uniqueTopic, waitFor } from "@joaofnds/flume-tck";
import { JetStreamManager, jetstreamManager } from "@nats-io/jetstream";
import { NatsConnection } from "@nats-io/nats-core";
import { connect } from "@nats-io/transport-node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrokerProbe, NatsStreamsBroker } from "../src/index";
import { durableFor, STREAM } from "../src/subject";
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
	let admin: NatsConnection;
	let jsm: JetStreamManager;

	beforeEach(async () => {
		probe = new RecordingBrokerProbe();
		admin = await connect({ servers: NATS_URL });
		jsm = await jetstreamManager(admin);
	});

	afterEach(async () => {
		await Promise.all(open.splice(0).map((broker) => broker.close()));
		await admin.close();
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

	it(
		"reports a consumer stall when the durable is deleted underneath it",
		async () => {
			const broker = await start();
			const sub = subscription(uniqueTopic(), "h");
			// the instanceId is unused for a competing subscription
			const durable = durableFor(sub, "");
			await broker.consume(sub, async () => {});

			await jsm.consumers.delete(STREAM, durable);

			await waitFor(() => probe.consumerStalledCalls.length > 0, {
				timeout: 30000,
				message: "a durable deleted server-side should surface via the probe",
			});
		},
		40000,
	);

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
