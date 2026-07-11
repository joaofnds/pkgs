import {
	DeliveredMessage,
	DeliveryMode,
	EventHandler,
	RetryPolicy,
	Subscription,
	Topic,
} from "@joaofnds/flume";
import { uniqueTopic, waitFor } from "@joaofnds/flume-tck";
import { Throughput } from "@joaofnds/throughput";
import { afterEach, describe, expect, it } from "vitest";
import { BrokerSaturation } from "../src/index";
import { BrokerHarness } from "./support/harness";

const NOOP_HANDLER: EventHandler = { async handle() {} };

function subscription(topic: string, name: string): Subscription {
	return new Subscription({
		topic: new Topic(topic),
		name,
		handler: NOOP_HANDLER,
		retry: new RetryPolicy({ maxAttempts: 3 }),
		delivery: DeliveryMode.Competing,
	});
}

class Deliveries {
	readonly messages: DeliveredMessage[] = [];
	mode: "ack" | "nack" = "ack";

	deliver = async (msg: DeliveredMessage): Promise<void> => {
		this.messages.push(msg);
		if (this.mode === "ack") await msg.ack();
		else await msg.nack();
	};
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function snapshotFor(
	saturation: BrokerSaturation,
	stream: string,
	group: string,
) {
	return saturation.consumers.find(
		(c) => c.stream === stream && c.group === group,
	);
}

describe("saturation gauges", () => {
	const open: BrokerHarness[] = [];

	afterEach(async () => {
		await Promise.all(open.splice(0).map((harness) => harness.stop()));
	});

	async function start(throughput?: Throughput): Promise<BrokerHarness> {
		const harness = await BrokerHarness.start({}, undefined, throughput);
		open.push(harness);
		return harness;
	}

	it("reports stream depth with no pending once every message is acked", async () => {
		const harness = await start();
		const topic = uniqueTopic();
		const deliveries = new Deliveries();
		await harness.broker.consume(subscription(topic, "h"), deliveries.deliver);

		for (let i = 0; i < 4; i++) {
			await harness.broker.publish(new Topic(topic), encode(`m${i}`));
		}
		await waitFor(() => deliveries.messages.length === 4);

		const snapshot = snapshotFor(
			await harness.broker.sampleSaturation(),
			topic,
			"flume:h",
		);
		expect(snapshot).toEqual({
			stream: topic,
			group: "flume:h",
			streamDepth: 4,
			pendingCount: 0,
			consumerLag: 0,
		});
	});

	it("reports the pending count while messages stay unacked", async () => {
		const harness = await start();
		const topic = uniqueTopic();
		const deliveries = new Deliveries();
		deliveries.mode = "nack";
		await harness.broker.consume(subscription(topic, "h"), deliveries.deliver);

		for (let i = 0; i < 3; i++) {
			await harness.broker.publish(new Topic(topic), encode(`m${i}`));
		}
		await waitFor(() => deliveries.messages.length === 3);

		const snapshot = snapshotFor(
			await harness.broker.sampleSaturation(),
			topic,
			"flume:h",
		);
		expect(snapshot?.streamDepth).toBe(3);
		expect(snapshot?.pendingCount).toBe(3);
	});

	it("reports local throughput per second after deliveries", async () => {
		const harness = await start(new Throughput(20, 25));
		const topic = uniqueTopic();
		const deliveries = new Deliveries();
		await harness.broker.consume(subscription(topic, "h"), deliveries.deliver);

		for (let i = 0; i < 5; i++) {
			await harness.broker.publish(new Topic(topic), encode(`m${i}`));
		}
		await waitFor(() => deliveries.messages.length === 5);

		await waitFor(
			async () =>
				(await harness.broker.sampleSaturation()).throughputPerSecond > 0,
			{ message: "throughput should reflect the delivered messages" },
		);
	});
});
