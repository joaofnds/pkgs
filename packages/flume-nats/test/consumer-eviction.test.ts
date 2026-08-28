import {
	DeliveryMode,
	RetryPolicy,
	Subscription,
	Topic,
} from "@joaofnds/flume";
import { uniqueTopic, waitFor } from "@joaofnds/flume-tck";
import {
	JetStreamManager,
	jetstream,
	jetstreamManager,
} from "@nats-io/jetstream";
import { NatsConnection } from "@nats-io/nats-core";
import { connect } from "@nats-io/transport-node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consumeOptionsFor } from "../src/consume-options";
import { ConsumerDrain } from "../src/consumer-drain";
import { ConsumerRegistry } from "../src/consumer-registry";
import { ensureConsumer, ensureStream } from "../src/jetstream-topology";
import { NoopBrokerProbe } from "../src/noop-broker-probe";
import { durableFor, STREAM } from "../src/subject";

const NATS_URL = "nats://localhost:4223";

function subscription(topicName: string): Subscription {
	return new Subscription({
		topic: new Topic(topicName),
		name: "h",
		handler: { async handle() {} },
		retry: new RetryPolicy({ maxAttempts: 3 }),
		delivery: DeliveryMode.Competing,
	});
}

describe("ConsumerRegistry against a live JetStream consumer", () => {
	let admin: NatsConnection;
	let jsm: JetStreamManager;
	let sub: Subscription;
	let durable: string;

	beforeEach(async () => {
		admin = await connect({ servers: NATS_URL });
		jsm = await jetstreamManager(admin);
		await ensureStream(jsm);
		sub = subscription(uniqueTopic());
		// the instanceId is unused for a competing subscription
		durable = durableFor(sub, "");
		await ensureConsumer(jsm, durable, sub, 2000);
	});

	afterEach(async () => {
		await jsm.consumers.delete(STREAM, durable);
		await admin.close();
	});

	it("drops the entry when the connection closes under the consumer", async () => {
		const nc = await connect({ servers: NATS_URL });
		const js = jetstream(nc);
		const consumer = await js.consumers.get(STREAM, durable);
		const messages = await consumer.consume(consumeOptionsFor(1));
		const registry = new ConsumerRegistry();
		registry.add(messages);
		void new ConsumerDrain(new NoopBrokerProbe(), 1).drain(
			messages,
			sub.topic,
			durable,
			async () => {},
		);

		await nc.close();

		await waitFor(() => registry.size === 0);
		expect(registry.size).toBe(0);
	});
});
