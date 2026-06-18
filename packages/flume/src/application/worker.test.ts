import { beforeEach, describe, expect, it } from "vitest";
import {
	type Bytes,
	type Codec,
	DeadLetter,
	DeliveryMode,
	Dispatcher,
	DuplicateSubscriptionError,
	Envelope,
	type EventHandler,
	JsonCodec,
	type Probe,
	RetryPolicy,
	Subscription,
	Topic,
	Worker,
	WorkerAlreadyStartedError,
} from "../index";
import {
	OrderProbe,
	RawBytesCodec,
	RecordingHandler,
	ThrowingProbe,
} from "../test-support";
import { FakeBroker, FakeClock, FakeProbe } from "../testing/index";

const DEAD_LETTER = "user.created:dead:send-email";

describe(Worker, () => {
	const topic = new Topic("user.created");
	let broker: FakeBroker;
	let codec: JsonCodec;
	let probe: FakeProbe;
	let handler: RecordingHandler;

	beforeEach(() => {
		broker = new FakeBroker();
		codec = new JsonCodec();
		probe = new FakeProbe();
		handler = new RecordingHandler();
	});

	function worker(withProbe: Probe = probe): Worker {
		return new Worker(broker, broker, codec, withProbe);
	}

	function subscription(
		overrides: {
			name?: string;
			handler?: EventHandler;
			maxAttempts?: number;
		} = {},
	): Subscription {
		return new Subscription({
			topic,
			name: overrides.name ?? "send-email",
			handler: overrides.handler ?? handler,
			retry: new RetryPolicy({ maxAttempts: overrides.maxAttempts ?? 5 }),
			delivery: DeliveryMode.Competing,
		});
	}

	function envelopeBytes(payload: unknown, withCodec: Codec = codec): Bytes {
		return new Envelope({
			dispatchedAt: new Date(0),
			payload: withCodec.encode(payload),
		}).toBytes();
	}

	describe("register", () => {
		it("rejects a second subscription with the same topic and name", () => {
			const w = worker();
			w.register(subscription({ name: "send-email" }));

			expect(() => w.register(subscription({ name: "send-email" }))).toThrow(
				DuplicateSubscriptionError,
			);
		});

		it("accepts subscriptions that differ in name", () => {
			const w = worker();
			w.register(subscription({ name: "one" }));

			expect(() => w.register(subscription({ name: "two" }))).not.toThrow();
		});
	});

	it("does not run the handler until a message is delivered", async () => {
		const sub = subscription();
		const w = worker();
		w.register(sub);
		await w.start();
		const dispatcher = new Dispatcher(broker, codec, new FakeClock(), probe);

		await dispatcher.dispatch(topic, { foo: "bar" });
		await dispatcher.dispatch(topic, { bar: "baz" });

		expect(handler.events).toHaveLength(0);
		expect(broker.published).toHaveLength(2);

		await broker.deliverFresh(sub, { id: "1", body: broker.published[0].body });
		await broker.deliverFresh(sub, { id: "2", body: broker.published[1].body });

		expect(handler.payloads()).toEqual([{ foo: "bar" }, { bar: "baz" }]);
	});

	it("acks and reports a processed message on a fresh delivery", async () => {
		const sub = subscription();
		const w = worker();
		w.register(sub);
		await w.start();

		const msg = await broker.deliverFresh(sub, {
			id: "7",
			body: envelopeBytes({ ok: true }),
		});

		expect(handler.payloads()).toEqual([{ ok: true }]);
		expect(msg.acked).toBe(true);
		expect(msg.nacked).toBe(false);
		expect(probe.processedCalls).toHaveLength(1);
	});

	it("builds the event from broker id/count and envelope dispatchedAt", async () => {
		const sub = subscription();
		const w = worker();
		w.register(sub);
		await w.start();
		const dispatchedAt = new Date("2026-06-18T00:00:00.000Z");
		const body = new Envelope({
			dispatchedAt,
			payload: codec.encode({ a: 1 }),
		}).toBytes();

		await broker.deliverFresh(sub, { id: "42-0", body });

		const event = handler.events[0];
		expect(event.id).toBe("42-0");
		expect(event.deliveryCount).toBe(1);
		expect(event.dispatchedAt).toEqual(dispatchedAt);
		expect(event.topic.name).toBe("user.created");
		expect(event.payload).toEqual({ a: 1 });
	});

	it("nacks and reports failure when the handler throws", async () => {
		handler.shouldFail = true;
		const sub = subscription();
		const w = worker();
		w.register(sub);
		await w.start();

		const msg = await broker.deliverFresh(sub, {
			id: "1",
			body: envelopeBytes({ x: 1 }),
		});

		expect(msg.nacked).toBe(true);
		expect(msg.acked).toBe(false);
		expect(probe.failedCalls).toHaveLength(1);
		expect(probe.processedCalls).toHaveLength(0);
	});

	describe("attempt accounting", () => {
		it("attempts the handler on a fresh delivery even when maxAttempts is 1", async () => {
			const sub = subscription({ maxAttempts: 1 });
			const w = worker();
			w.register(sub);
			await w.start();

			const msg = await broker.deliverFresh(sub, {
				id: "1",
				body: envelopeBytes({ x: 1 }),
			});

			expect(handler.events).toHaveLength(1);
			expect(msg.acked).toBe(true);
			expect(broker.publishedTo(DEAD_LETTER)).toHaveLength(0);
		});

		it("dead-letters on the first redelivery when maxAttempts is 1", async () => {
			handler.shouldFail = true;
			const sub = subscription({ maxAttempts: 1 });
			const w = worker();
			w.register(sub);
			await w.start();
			const body = envelopeBytes({ x: 1 });

			await broker.deliverFresh(sub, { id: "1", body });
			const dead = await broker.redeliver(sub, { id: "1", body, count: 2 });

			expect(handler.events).toHaveLength(1);
			expect(dead.acked).toBe(true);
			expect(dead.nacked).toBe(false);
			const dlq = broker.publishedTo(DEAD_LETTER);
			expect(dlq).toHaveLength(1);
			const parked = DeadLetter.parse(dlq[0].body);
			expect(parked.originalId).toBe("1");
			expect(parked.body).toEqual(body);
			expect(probe.deadLetteredCalls).toHaveLength(1);
		});

		it("attempts twice then dead-letters when maxAttempts is 2", async () => {
			handler.shouldFail = true;
			const sub = subscription({ maxAttempts: 2 });
			const w = worker();
			w.register(sub);
			await w.start();
			const body = envelopeBytes({ x: 1 });

			await broker.deliverFresh(sub, { id: "1", body });
			await broker.redeliver(sub, { id: "1", body, count: 2 });
			const dead = await broker.redeliver(sub, { id: "1", body, count: 3 });

			expect(handler.events).toHaveLength(2);
			expect(dead.acked).toBe(true);
			expect(broker.publishedTo(DEAD_LETTER)).toHaveLength(1);
		});

		it("re-attempts on redelivery and acks when the handler recovers", async () => {
			const sub = subscription({ maxAttempts: 3 });
			const w = worker();
			w.register(sub);
			await w.start();
			const body = envelopeBytes({ x: 1 });

			handler.shouldFail = true;
			const first = await broker.deliverFresh(sub, { id: "1", body });
			expect(first.nacked).toBe(true);

			handler.shouldFail = false;
			const second = await broker.redeliver(sub, { id: "1", body, count: 2 });

			expect(second.acked).toBe(true);
			expect(handler.events).toHaveLength(2);
			expect(broker.publishedTo(DEAD_LETTER)).toHaveLength(0);
		});
	});

	it("processes each handler independently when one fails", async () => {
		const handlerOne = new RecordingHandler();
		const handlerTwo = new RecordingHandler();
		handlerTwo.shouldFail = true;
		const subOne = subscription({ name: "one", handler: handlerOne });
		const subTwo = subscription({ name: "two", handler: handlerTwo });
		const w = worker();
		w.register(subOne);
		w.register(subTwo);
		await w.start();
		const body = envelopeBytes({ foo: "bar" });

		const msgOne = await broker.deliverFresh(subOne, { id: "1", body });
		const msgTwo = await broker.deliverFresh(subTwo, { id: "1", body });

		expect(handlerOne.payloads()).toEqual([{ foo: "bar" }]);
		expect(handlerTwo.payloads()).toEqual([{ foo: "bar" }]);
		expect(msgOne.acked).toBe(true);
		expect(msgTwo.nacked).toBe(true);
		expect(msgTwo.acked).toBe(false);
	});

	describe("when the probe throws", () => {
		it("still acks a processed message", async () => {
			const sub = subscription();
			const w = worker(new ThrowingProbe());
			w.register(sub);
			await w.start();

			const msg = await broker.deliverFresh(sub, {
				id: "1",
				body: envelopeBytes({ x: 1 }),
			});

			expect(msg.acked).toBe(true);
			expect(handler.events).toHaveLength(1);
		});

		it("still nacks a failed message", async () => {
			handler.shouldFail = true;
			const sub = subscription();
			const w = worker(new ThrowingProbe());
			w.register(sub);
			await w.start();

			const msg = await broker.deliverFresh(sub, {
				id: "1",
				body: envelopeBytes({ x: 1 }),
			});

			expect(msg.nacked).toBe(true);
		});

		it("still dead-letters and acks an exhausted message", async () => {
			handler.shouldFail = true;
			const sub = subscription({ maxAttempts: 1 });
			const w = worker(new ThrowingProbe());
			w.register(sub);
			await w.start();
			const body = envelopeBytes({ x: 1 });

			await broker.deliverFresh(sub, { id: "1", body });
			const dead = await broker.redeliver(sub, { id: "1", body, count: 2 });

			expect(dead.acked).toBe(true);
			expect(broker.publishedTo(DEAD_LETTER)).toHaveLength(1);
		});
	});

	describe("reports to the probe only after the broker side-effect", () => {
		it("acks before reporting a processed message", async () => {
			const order = new OrderProbe();
			const sub = subscription();
			const w = worker(order);
			w.register(sub);
			await w.start();

			await broker.deliverFresh(sub, {
				id: "1",
				body: envelopeBytes({ x: 1 }),
			});

			expect(order.calls).toEqual([
				{ call: "processed", acked: true, nacked: false },
			]);
		});

		it("nacks before reporting a failure", async () => {
			handler.shouldFail = true;
			const order = new OrderProbe();
			const sub = subscription();
			const w = worker(order);
			w.register(sub);
			await w.start();

			await broker.deliverFresh(sub, {
				id: "1",
				body: envelopeBytes({ x: 1 }),
			});

			expect(order.calls).toEqual([
				{ call: "failed", acked: false, nacked: true },
			]);
		});

		it("acks before reporting a dead-letter", async () => {
			handler.shouldFail = true;
			const order = new OrderProbe();
			const sub = subscription({ maxAttempts: 1 });
			const w = worker(order);
			w.register(sub);
			await w.start();
			const body = envelopeBytes({ x: 1 });

			await broker.deliverFresh(sub, { id: "1", body });
			await broker.redeliver(sub, { id: "1", body, count: 2 });

			expect(order.calls).toEqual([
				{ call: "failed", acked: false, nacked: true },
				{ call: "deadLettered", acked: true, nacked: false },
			]);
		});
	});

	describe("start", () => {
		it("rejects a second start", async () => {
			const w = worker();
			w.register(subscription());
			await w.start();

			await expect(w.start()).rejects.toThrow(WorkerAlreadyStartedError);
		});

		it("rejects registration after start", async () => {
			const w = worker();
			w.register(subscription({ name: "one" }));
			await w.start();

			expect(() => w.register(subscription({ name: "two" }))).toThrow(
				WorkerAlreadyStartedError,
			);
		});
	});

	it("delivers a non-UTF-8 payload through the codec unchanged", async () => {
		const rawCodec = new RawBytesCodec();
		const raw = new Uint8Array([0xff, 0xfe, 0x00, 0x10, 0x7f]);
		const sub = subscription();
		const w = new Worker(broker, broker, rawCodec, probe);
		w.register(sub);
		await w.start();
		const body = new Envelope({
			dispatchedAt: new Date(0),
			payload: rawCodec.encode(raw),
		}).toBytes();

		await broker.deliverFresh(sub, { id: "1", body });

		expect(handler.events[0].payload).toEqual(raw);
	});

	it("stops delivering after stop", async () => {
		const sub = subscription();
		const w = worker();
		w.register(sub);
		await w.start();
		await w.stop();

		await expect(
			broker.deliverFresh(sub, { id: "1", body: envelopeBytes({}) }),
		).rejects.toThrow();
	});
});
