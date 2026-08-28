import { setTimeout as sleep } from "node:timers/promises";
import {
	DeliveredMessage,
	DeliveryMode,
	EventHandler,
	RetryPolicy,
	StartFrom,
	Subscription,
	Topic,
} from "@joaofnds/flume";
import { uniqueTopic, waitFor } from "@joaofnds/flume-tck";
import { describe, expect, it } from "vitest";
import { BrokerHarness } from "./support/harness";

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

const SPARSE_ORPHAN = "flume:cache:dead-inst";

function registryGroups(prefix: string, count: number): string[] {
	return Array.from({ length: count }, (_, i) => `flume:cache:${prefix}-${i}`);
}

describe("broadcast delivery + group reaper", () => {
	async function startInstance(
		overrides: Parameters<typeof BrokerHarness.start>[0] = {},
	): Promise<BrokerHarness> {
		return BrokerHarness.start({
			broadcast: FAST_BROADCAST,
			...overrides,
		});
	}

	it("delivers every event to each instance's own per-instance group", async () => {
		const topic = uniqueTopic();
		await using a = await startInstance({
			instanceId: "inst-a",
			reaper: { interval: 1000, trim: false },
		});
		await using b = await startInstance({
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
		await using live = await startInstance({
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
		await using live = await startInstance({
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
		await using harness = await startInstance({
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

	it("reaps one registry page per stream per sweep", async () => {
		const crowded = uniqueTopic();
		const sparse = uniqueTopic();
		const liveWall = registryGroups("live", 150);
		const buried = registryGroups("buried", 150);
		await using harness = await BrokerHarness.start({
			reaper: { interval: 100, trim: false },
		});
		for (const group of liveWall) {
			await harness.seedOrphanBroadcastGroup(crowded, group);
			await harness.maint.set(`flume:hb:${group}`, "1");
		}
		for (const group of buried) {
			await harness.seedOrphanBroadcastGroup(crowded, group);
		}
		await harness.seedOrphanBroadcastGroup(sparse, SPARSE_ORPHAN);

		await harness.broker.consume(
			broadcastSub(crowded, "cache"),
			new Deliveries().deliver,
		);
		await harness.broker.consume(
			broadcastSub(sparse, "cache"),
			new Deliveries().deliver,
		);

		await waitFor(
			async () =>
				!(await harness.registryMembers(sparse)).includes(SPARSE_ORPHAN),
			{
				message:
					"the sparse stream's orphan should be reaped without waiting out the crowded registry",
			},
		);
		const stillBuried = (await harness.registryMembers(crowded)).filter(
			(member) => buried.includes(member),
		);
		expect(stillBuried.length).toBeGreaterThanOrEqual(50);

		await waitFor(
			async () => {
				const members = await harness.registryMembers(crowded);
				return buried.every((group) => !members.includes(group));
			},
			{
				message:
					"later sweeps should advance the cursor past the live wall and reap every buried orphan",
			},
		);
		expect(await harness.registryMembers(crowded)).toEqual(
			expect.arrayContaining(liveWall),
		);
		expect(await harness.registryMembers(crowded)).toHaveLength(
			liveWall.length + 1,
		);
		expect(await harness.registryMembers(sparse)).toHaveLength(1);
	});

	it("trims a live stream by MINID only over groups that survive the reaper", async () => {
		const topic = uniqueTopic();
		await using harness = await startInstance({
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
