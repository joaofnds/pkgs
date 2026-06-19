import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
	DeliveredMessage,
	DeliveryMode,
	EventHandler,
	RetryPolicy,
	StartFrom,
	Subscription,
	Topic,
} from "../src/index";
import { BrokerHarness } from "./support/harness";
import { uniqueTopic, waitFor } from "./support/wait";

const NOOP: EventHandler = { async handle() {} };

const FAST_BROADCAST = { heartbeatInterval: 25, heartbeatTtl: 100 };

function sub(
	topic: string,
	name: string,
	options: { delivery?: DeliveryMode; startFrom?: StartFrom } = {},
): Subscription {
	return new Subscription({
		topic: new Topic(topic),
		name,
		handler: NOOP,
		retry: new RetryPolicy({ maxAttempts: 3 }),
		delivery: options.delivery ?? DeliveryMode.Competing,
		startFrom: options.startFrom,
	});
}

function broadcastSub(topic: string, name: string): Subscription {
	return sub(topic, name, { delivery: DeliveryMode.Broadcast });
}

class Deliveries {
	readonly messages: DeliveredMessage[] = [];

	deliver = async (msg: DeliveredMessage): Promise<void> => {
		this.messages.push(msg);
		await msg.ack();
	};

	bodies(): string[] {
		return this.messages.map((m) => new TextDecoder().decode(m.body));
	}
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("broadcast delivery + group reaper", () => {
	const open: BrokerHarness[] = [];

	async function startInstance(
		overrides: Parameters<typeof BrokerHarness.start>[0] = {},
	): Promise<BrokerHarness> {
		const harness = await BrokerHarness.start({
			broadcast: FAST_BROADCAST,
			...overrides,
		});
		open.push(harness);
		return harness;
	}

	afterEach(async () => {
		await Promise.all(open.splice(0).map((harness) => harness.stop()));
	});

	it("delivers every event to each instance's own per-instance group", async () => {
		const topic = uniqueTopic();
		const a = await startInstance({
			instanceId: "inst-a",
			reaper: { interval: 1000, trim: false },
		});
		const b = await startInstance({
			instanceId: "inst-b",
			reaper: { interval: 1000, trim: false },
		});
		const da = new Deliveries();
		const db = new Deliveries();
		await a.broker.consume(broadcastSub(topic, "cache"), da.deliver);
		await b.broker.consume(broadcastSub(topic, "cache"), db.deliver);

		await a.broker.publish(new Topic(topic), encode("invalidate"));

		await waitFor(() => da.messages.length === 1 && db.messages.length === 1, {
			message: "both instances should receive the broadcast event",
		});
		expect(da.bodies()).toEqual(["invalidate"]);
		expect(db.bodies()).toEqual(["invalidate"]);
		expect((await a.groupNames(topic)).sort()).toEqual([
			"flume:cache:inst-a",
			"flume:cache:inst-b",
		]);
	});

	it("reaps a dead instance's orphaned broadcast group while keeping live ones", async () => {
		const topic = uniqueTopic();
		const live = await startInstance({
			instanceId: "inst-a",
			reaper: { interval: 40, trim: false },
		});
		await live.broker.consume(
			broadcastSub(topic, "cache"),
			new Deliveries().deliver,
		);

		const orphan = "flume:cache:dead-inst";
		await live.seedOrphanBroadcastGroup(topic, orphan);
		expect(await live.groupNames(topic)).toContain(orphan);

		await waitFor(
			async () => !(await live.groupNames(topic)).includes(orphan),
			{
				message: "the orphan group with no heartbeat should be reaped",
			},
		);
		expect(await live.groupNames(topic)).toContain("flume:cache:inst-a");
		expect(await live.registryMembers(topic)).not.toContain(orphan);
	});

	it("does not reap a live broadcast group whose heartbeat is current", async () => {
		const topic = uniqueTopic();
		const live = await startInstance({
			instanceId: "inst-a",
			reaper: { interval: 30, trim: false },
		});
		await live.broker.consume(
			broadcastSub(topic, "cache"),
			new Deliveries().deliver,
		);

		await sleep(200);
		expect(await live.groupNames(topic)).toContain("flume:cache:inst-a");
		expect(await live.keyExists("flume:hb:flume:cache:inst-a")).toBe(true);
	});

	it("destroys this instance's broadcast group on graceful stop", async () => {
		const topic = uniqueTopic();
		const harness = await startInstance({
			instanceId: "inst-a",
			reaper: { interval: 1000, trim: false },
		});
		await harness.broker.consume(
			broadcastSub(topic, "cache"),
			new Deliveries().deliver,
		);
		expect(await harness.groupNames(topic)).toContain("flume:cache:inst-a");

		await harness.broker.close();

		expect(await harness.groupNames(topic)).not.toContain("flume:cache:inst-a");
		expect(await harness.registryMembers(topic)).not.toContain(
			"flume:cache:inst-a",
		);
	});

	it("trims a live stream by MINID only over groups that survive the reaper", async () => {
		const topic = uniqueTopic();
		const harness = await startInstance({
			reaper: { interval: 40, trim: true },
		});
		const worker = new Deliveries();
		await harness.broker.consume(sub(topic, "worker"), worker.deliver);
		await harness.seedOrphanBroadcastGroup(
			topic,
			"flume:worker:dead-inst",
			"0",
		);

		const count = 5;
		for (let i = 0; i < count; i++) {
			await harness.broker.publish(new Topic(topic), encode(`m${i}`));
		}
		await waitFor(() => worker.messages.length === count, {
			message: "the worker should read and ack every message",
		});

		await waitFor(async () => (await harness.streamLength(topic)) === 1, {
			message:
				"stream should trim to the worker's low-water-mark once the orphan is reaped",
		});
		expect(await harness.groupNames(topic)).not.toContain(
			"flume:worker:dead-inst",
		);
	});
});
