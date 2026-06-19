import { beforeEach, describe, expect, it } from "vitest";
import {
	type DeliveredMessage,
	DeliveryMode,
	RetryPolicy,
	Subscription,
	Topic,
} from "../index";
import { FakeBroker } from "./fake-broker";
import { RecordingHandler } from "./recording-handler";

describe(FakeBroker, () => {
	const sub = new Subscription({
		topic: new Topic("user.created"),
		name: "send-email",
		handler: new RecordingHandler(),
		retry: new RetryPolicy({ maxAttempts: 1 }),
		delivery: DeliveryMode.Competing,
	});
	let broker: FakeBroker;
	let delivered: DeliveredMessage[];

	beforeEach(async () => {
		broker = new FakeBroker();
		delivered = [];
		await broker.consume(sub, async (msg) => {
			delivered.push(msg);
		});
	});

	it("delivers a fresh message with delivery count 1", async () => {
		await broker.deliverFresh(sub, { id: "1", body: new Uint8Array() });

		expect(delivered[0].deliveryCount).toBe(1);
	});

	it("redelivers with the supplied count", async () => {
		await broker.redeliver(sub, { id: "1", body: new Uint8Array(), count: 3 });

		expect(delivered[0].deliveryCount).toBe(3);
	});

	it("refuses a redelivery with a fresh-delivery count", async () => {
		await expect(
			broker.redeliver(sub, { id: "1", body: new Uint8Array(), count: 1 }),
		).rejects.toThrow();
	});

	it("refuses to deliver to a subscription with no consumer", async () => {
		const other = new Subscription({
			topic: new Topic("user.created"),
			name: "other",
			handler: new RecordingHandler(),
			retry: new RetryPolicy({ maxAttempts: 1 }),
			delivery: DeliveryMode.Competing,
		});

		await expect(
			broker.deliverFresh(other, { id: "1", body: new Uint8Array() }),
		).rejects.toThrow();
	});

	it("records every published message", async () => {
		await broker.publish(new Topic("a"), new Uint8Array([1]));
		await broker.publish(new Topic("b"), new Uint8Array([2]));

		expect(broker.published).toHaveLength(2);
		expect(broker.publishedTo("b")).toHaveLength(1);
	});
});
