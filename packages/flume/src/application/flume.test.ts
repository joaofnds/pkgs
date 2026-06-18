import { beforeEach, describe, expect, it } from "vitest";
import {
	DeliveryMode,
	DuplicateSubscriptionError,
	Envelope,
	Flume,
	JsonCodec,
	RetryPolicy,
	Subscription,
	Topic,
} from "../index";
import { RecordingHandler } from "../test-support";
import { FakeBroker, FakeClock, FakeProbe } from "../testing/index";

describe(Flume, () => {
	let broker: FakeBroker;
	let flume: Flume;

	beforeEach(() => {
		broker = new FakeBroker();
		flume = new Flume({
			namespace: "billing",
			broker,
			codec: new JsonCodec(),
			clock: new FakeClock(),
			probe: new FakeProbe(),
		});
	});

	it("exposes its namespace", () => {
		expect(flume.namespace).toBe("billing");
	});

	it("emits a durable framed event", async () => {
		await flume.emit("user.created", { userId: "1" });

		expect(broker.published).toHaveLength(1);
		const envelope = Envelope.parse(broker.published[0].body);
		expect(new JsonCodec().decode(envelope.payload)).toEqual({ userId: "1" });
	});

	it("rejects two subscriptions with the same topic and name", () => {
		flume.on("user.created", "send-welcome", new RecordingHandler());

		expect(() =>
			flume.on("user.created", "send-welcome", new RecordingHandler()),
		).toThrow(DuplicateSubscriptionError);
	});

	it("allows the same name on different topics", () => {
		flume.on("user.created", "send-welcome", new RecordingHandler());

		expect(() =>
			flume.on("user.deleted", "send-welcome", new RecordingHandler()),
		).not.toThrow();
	});

	it("folds the namespace into the durable subscription name", async () => {
		const handler = new RecordingHandler();
		flume.on("user.created", "send-welcome", handler);
		await flume.start();
		const namespaced = new Subscription({
			topic: new Topic("user.created"),
			name: "billing:send-welcome",
			handler,
			retry: new RetryPolicy({ maxAttempts: 1 }),
			delivery: DeliveryMode.Competing,
		});

		await flume.emit("user.created", { id: 1 });
		await broker.deliverFresh(namespaced, {
			id: "1",
			body: broker.published[0].body,
		});

		expect(handler.payloads()).toEqual([{ id: 1 }]);
	});

	it("starts and stops without error", async () => {
		flume.on("user.created", "send-welcome", new RecordingHandler());

		await expect(flume.start()).resolves.toBeUndefined();
		await expect(flume.stop()).resolves.toBeUndefined();
	});
});
