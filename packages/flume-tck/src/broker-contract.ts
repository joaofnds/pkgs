import { setTimeout as sleep } from "node:timers/promises";
import {
	Broker,
	DeadLetter,
	DeliveryMode,
	EventHandler,
	Flume,
	JsonCodec,
	RetryPolicy,
	StartFrom,
	Subscription,
	SystemClock,
	Topic,
} from "@joaofnds/flume";
import { FakeProbe, RecordingHandler } from "@joaofnds/flume/testing";
import { afterEach, describe, expect, it } from "vitest";
import { Collector } from "./collector";
import { uniqueTopic, waitFor } from "./wait";

export interface BrokerCapabilities {
	// redelivers a nacked / unacked message with an incremented delivery count.
	// Gates the retry and dead-letter behaviors (a fresh delivery is always
	// attempt 1, so dead-lettering only happens once a redelivery exceeds the cap).
	readonly redelivery: boolean;
	// a startFrom:"beginning" subscription replays events published before it.
	readonly startFromBeginning: boolean;
	// DeliveryMode.Broadcast gives every instance its own copy of every event.
	readonly broadcast: boolean;
	// supports re-publishing a dead-letter stream back onto its live topic.
	readonly redrive: boolean;
}

export interface MakeBrokerOptions {
	// distinct identity within a competing group (drives the competing-consumers test).
	readonly consumerName?: string;
	// distinct identity for a broadcast group (drives the broadcast test).
	readonly instanceId?: string;
}

export interface RedriveOutcome {
	readonly redriven: number;
	readonly skipped: number;
}

export interface BrokerContractOptions<B extends Broker> {
	makeBroker(options?: MakeBrokerOptions): Promise<B>;
	closeBroker(broker: B): Promise<void>;
	readonly capabilities: BrokerCapabilities;
	// required iff capabilities.redrive — the adapter's redriveDeadLetters method.
	redrive?(
		broker: B,
		args: { topic: Topic; name: string },
	): Promise<RedriveOutcome>;
	// folded into every subscription name; defaults to "tck".
	readonly namespace?: string;
}

const NOOP: EventHandler = { async handle() {} };
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

export function brokerContractTests<B extends Broker>(
	name: string,
	options: BrokerContractOptions<B>,
): void {
	const { makeBroker, closeBroker, capabilities } = options;
	const namespace = options.namespace ?? "tck";

	describe(`broker contract: ${name}`, () => {
		const open: B[] = [];

		async function broker(overrides?: MakeBrokerOptions): Promise<B> {
			const created = await makeBroker(overrides);
			open.push(created);
			return created;
		}

		afterEach(async () => {
			await Promise.all(open.splice(0).map((b) => closeBroker(b)));
		});

		function rawSub(
			topic: string,
			subName: string,
			opts: { delivery?: DeliveryMode; startFrom?: StartFrom } = {},
		): Subscription {
			return new Subscription({
				topic: new Topic(topic),
				name: subName,
				handler: NOOP,
				retry: new RetryPolicy({ maxAttempts: 3 }),
				delivery: opts.delivery ?? DeliveryMode.Competing,
				startFrom: opts.startFrom,
			});
		}

		function flumeOver(b: B): Flume {
			return new Flume({
				namespace,
				broker: b,
				codec: new JsonCodec(),
				clock: new SystemClock(),
				probe: new FakeProbe(),
			});
		}

		const deadTopic = (topic: string, subName: string): string =>
			`${topic}:dead:${namespace}:${subName}`;

		async function watchDeadLetters(b: B, topic: string): Promise<Collector> {
			const collector = new Collector();
			await b.consume(rawSub(topic, "tck-dead-watch"), collector.deliver);
			return collector;
		}

		it("delivers a freshly published message with deliveryCount 1", async () => {
			const b = await broker();
			const topic = uniqueTopic();
			const collector = new Collector();
			await b.consume(rawSub(topic, "h"), collector.deliver);

			await b.publish(new Topic(topic), encode("hello"));

			await waitFor(() => collector.messages.length === 1);
			expect(collector.messages[0].deliveryCount).toBe(1);
			expect(collector.bodies()).toEqual(["hello"]);
		});

		it("round-trips a non-UTF-8 payload without corruption", async () => {
			const b = await broker();
			const topic = uniqueTopic();
			const payload = new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0xfd, 0x80]);
			const collector = new Collector();
			await b.consume(rawSub(topic, "h"), collector.deliver);

			await b.publish(new Topic(topic), payload);

			await waitFor(() => collector.messages.length === 1);
			expect(Array.from(collector.messages[0].body)).toEqual(
				Array.from(payload),
			);
		});

		it("processes a published event exactly once", async () => {
			const b = await broker();
			const topic = uniqueTopic();
			const handler = new RecordingHandler();
			const flume = flumeOver(b);
			flume.on(topic, "consume", handler, {
				retry: new RetryPolicy({ maxAttempts: 3 }),
			});
			await flume.start();

			await flume.emit(topic, { hello: "world" });

			await waitFor(() => handler.events.length === 1);
			expect(handler.events[0].payload).toEqual({ hello: "world" });
			expect(handler.events[0].deliveryCount).toBe(1);

			await sleep(250);
			expect(handler.events).toHaveLength(1);
		});

		it("does not deliver events published before a startFrom:new subscription", async () => {
			const b = await broker();
			const topic = uniqueTopic();
			await b.publish(new Topic(topic), encode("old"));

			const collector = new Collector();
			await b.consume(
				rawSub(topic, "h", { startFrom: "new" }),
				collector.deliver,
			);
			await b.publish(new Topic(topic), encode("new"));

			await waitFor(() => collector.messages.length === 1);
			expect(collector.bodies()).toEqual(["new"]);
		});

		it("splits work across competing consumers in the same group", async () => {
			const topic = uniqueTopic();
			const a = await broker();
			const second = await broker({ consumerName: "tck-instance-b" });
			const da = new Collector();
			const db = new Collector();
			await a.consume(rawSub(topic, "shared"), da.deliver);
			await second.consume(rawSub(topic, "shared"), db.deliver);

			for (let i = 0; i < 4; i++) {
				await a.publish(new Topic(topic), encode(`m${i}`));
			}

			await waitFor(() => da.messages.length + db.messages.length === 4, {
				message: "all four messages should be delivered once across the group",
			});
			const ids = [...da.messages, ...db.messages].map((m) => m.id);
			expect(new Set(ids).size).toBe(4);
		});

		if (capabilities.startFromBeginning) {
			it("replays events published before a startFrom:beginning subscription", async () => {
				const b = await broker();
				const topic = uniqueTopic();
				await b.publish(new Topic(topic), encode("old"));

				const collector = new Collector();
				await b.consume(
					rawSub(topic, "h", { startFrom: "beginning" }),
					collector.deliver,
				);

				await waitFor(() => collector.bodies().includes("old"));
			});
		}

		if (capabilities.redelivery) {
			it("redelivers a nacked message with an incremented delivery count", async () => {
				const b = await broker();
				const topic = uniqueTopic();
				const collector = new Collector();
				collector.mode = "nack";
				await b.consume(rawSub(topic, "h"), collector.deliver);

				await b.publish(new Topic(topic), encode("retry-me"));

				await waitFor(() => collector.messages.length >= 2, {
					message: "a nacked message should be redelivered",
				});
				expect(collector.messages[0].deliveryCount).toBe(1);
				expect(collector.messages[1].deliveryCount).toBe(2);
				expect(collector.messages[0].id).toBe(collector.messages[1].id);
			});

			it("invokes a failing handler exactly maxAttempts=1 time then dead-letters", async () => {
				const b = await broker();
				const topic = uniqueTopic();
				const handler = new RecordingHandler();
				handler.shouldFail = true;
				const flume = flumeOver(b);
				flume.on(topic, "flaky", handler, {
					retry: new RetryPolicy({ maxAttempts: 1 }),
				});
				await flume.start();
				const dead = await watchDeadLetters(b, deadTopic(topic, "flaky"));

				await flume.emit(topic, { n: 1 });

				await waitFor(() => dead.messages.length === 1, {
					message: "an exhausted handler should dead-letter",
				});
				expect(handler.events).toHaveLength(1);
			});

			it("invokes a failing handler exactly maxAttempts=2 times then dead-letters with the original id", async () => {
				const b = await broker();
				const topic = uniqueTopic();
				const handler = new RecordingHandler();
				handler.shouldFail = true;
				const flume = flumeOver(b);
				flume.on(topic, "flaky", handler, {
					retry: new RetryPolicy({ maxAttempts: 2 }),
				});
				await flume.start();
				const dead = await watchDeadLetters(b, deadTopic(topic, "flaky"));

				await flume.emit(topic, { n: 2 });

				await waitFor(() => handler.events.length === 2, {
					message: "fresh delivery + one redelivery should invoke twice",
				});
				await waitFor(() => dead.messages.length === 1);
				expect(DeadLetter.parse(dead.messages[0].body).originalId).toBe(
					handler.events[0].id,
				);
				expect(handler.events).toHaveLength(2);
			});

			it("dead-letters a failing handler without affecting an independent handler on the same topic", async () => {
				const b = await broker();
				const topic = uniqueTopic();
				const healthy = new RecordingHandler();
				const failing = new RecordingHandler();
				failing.shouldFail = true;
				const flume = flumeOver(b);
				flume.on(topic, "healthy", healthy, {
					retry: new RetryPolicy({ maxAttempts: 1 }),
				});
				flume.on(topic, "failing", failing, {
					retry: new RetryPolicy({ maxAttempts: 1 }),
				});
				await flume.start();
				const failingDead = await watchDeadLetters(
					b,
					deadTopic(topic, "failing"),
				);
				const healthyDead = await watchDeadLetters(
					b,
					deadTopic(topic, "healthy"),
				);

				await flume.emit(topic, { shared: true });

				await waitFor(() => healthy.events.length === 1);
				await waitFor(() => failingDead.messages.length === 1);
				expect(healthy.events[0].payload).toEqual({ shared: true });

				await sleep(250);
				expect(healthyDead.messages).toHaveLength(0);
			});
		}

		if (capabilities.broadcast) {
			it("delivers every event to each instance's own broadcast group", async () => {
				const topic = uniqueTopic();
				const a = await broker({ instanceId: "tck-inst-a" });
				const second = await broker({ instanceId: "tck-inst-b" });
				const da = new Collector();
				const db = new Collector();
				const broadcast = { delivery: DeliveryMode.Broadcast };
				await a.consume(rawSub(topic, "cache", broadcast), da.deliver);
				await second.consume(rawSub(topic, "cache", broadcast), db.deliver);

				await a.publish(new Topic(topic), encode("invalidate"));

				await waitFor(
					() => da.messages.length === 1 && db.messages.length === 1,
					{ message: "both instances should receive the broadcast event" },
				);
				expect(da.bodies()).toEqual(["invalidate"]);
				expect(db.bodies()).toEqual(["invalidate"]);
			});
		}

		if (capabilities.redrive && capabilities.redelivery) {
			const redrive = options.redrive;
			if (!redrive) {
				throw new Error(
					"capabilities.redrive is true but no redrive() hook was provided",
				);
			}

			it("re-publishes a dead-lettered message so the handler reprocesses it", async () => {
				const b = await broker();
				const topic = uniqueTopic();
				const handler = new RecordingHandler();
				handler.shouldFail = true;
				const flume = flumeOver(b);
				flume.on(topic, "flaky", handler, {
					retry: new RetryPolicy({ maxAttempts: 1 }),
				});
				await flume.start();
				const dead = await watchDeadLetters(b, deadTopic(topic, "flaky"));

				await flume.emit(topic, { n: 1 });
				await waitFor(() => dead.messages.length === 1);
				expect(handler.events).toHaveLength(1);

				handler.shouldFail = false;
				const result = await redrive(b, {
					topic: new Topic(topic),
					name: `${namespace}:flaky`,
				});

				expect(result).toEqual({ redriven: 1, skipped: 0 });
				await waitFor(() => handler.events.length === 2, {
					message: "the handler should reprocess the redriven message",
				});
				expect(handler.events[1].payload).toEqual({ n: 1 });
			});

			it("reports zero on an empty or absent dead stream", async () => {
				const b = await broker();
				const topic = uniqueTopic();

				const result = await redrive(b, {
					topic: new Topic(topic),
					name: `${namespace}:flaky`,
				});

				expect(result).toEqual({ redriven: 0, skipped: 0 });
			});
		}
	});
}
