import {
	Broker,
	Bytes,
	DeadLetter,
	DeliveredMessage,
	DeliveryMode,
	RunningConsumer,
	StartFrom,
	Subscription,
	Topic,
} from "@joaofnds/flume";
import { Throughput } from "@joaofnds/throughput";
import { BrokerAlreadyConnectedError } from "./broker-already-connected-error";
import { BrokerNotConnectedError } from "./broker-not-connected-error";
import { BrokerProbe } from "./broker-probe";
import { BrokerSaturation } from "./broker-saturation";
import { ClientLifecycle } from "./client-lifecycle";
import { createReadClient, createWriteClient, WriteClient } from "./clients";
import { ConsumerLoop } from "./consumer-loop";
import { ConsumerHandle, ConsumerRegistry } from "./consumer-registry";
import { ConsumerSaturation } from "./consumer-saturation";
import { asBrokerError } from "./errors";
import { GuardedBrokerProbe } from "./guarded-broker-probe";
import { MaintenanceSweep } from "./maintenance-sweep";
import { NoopBrokerProbe } from "./noop-broker-probe";
import {
	RedisStreamsBrokerOptions,
	ResolvedOptions,
	resolveOptions,
} from "./options";
import { RedriveResult } from "./redrive-result";
import { minStreamId } from "./stream-id";
import { bodyOf, PAYLOAD_FIELD } from "./stream-message";

const REGISTRY_SCAN_COUNT = 100;

export class RedisStreamsBroker implements Broker {
	private readonly options: ResolvedOptions;
	private readonly createThroughput: () => Throughput;
	private readonly throughput: Throughput;
	private readonly probe: BrokerProbe;
	private writeClient?: WriteClient;
	private lifecycle?: ClientLifecycle;
	private readonly heartbeatSweep: MaintenanceSweep;
	private readonly reapSweep: MaintenanceSweep;
	private readonly consumers = new ConsumerRegistry();
	private readonly registryCursors = new Map<string, string>();

	constructor(
		options: RedisStreamsBrokerOptions,
		probe: BrokerProbe = new NoopBrokerProbe(),
		throughput: () => Throughput = () => new Throughput(60, 1000),
	) {
		this.options = resolveOptions(options);
		this.createThroughput = throughput;
		this.throughput = throughput();
		this.probe = new GuardedBrokerProbe(probe);

		this.heartbeatSweep = new MaintenanceSweep(
			() => this.heartbeat(),
			(error) => this.probe.heartbeatFailed(error),
			this.options.broadcast.heartbeatInterval,
		);
		this.reapSweep = new MaintenanceSweep(
			() => this.reap(),
			(error) => this.probe.reapFailed(error),
			this.options.reaper.interval,
		);
	}

	async connect(): Promise<void> {
		if (this.writeClient !== undefined) throw new BrokerAlreadyConnectedError();

		try {
			this.writeClient = createWriteClient(this.options.redis);
			this.lifecycle = new ClientLifecycle(this.probe);
			this.lifecycle.watch(this.writeClient);
			await this.writeClient.connect();
		} catch (error) {
			this.lifecycle?.stop();
			await Promise.allSettled([this.writeClient?.close()]);
			this.writeClient = undefined;
			this.lifecycle = undefined;
			throw error;
		}

		this.throughput.start();
		this.heartbeatSweep.start();
		this.reapSweep.start();
	}

	async close(): Promise<void> {
		this.lifecycle?.stop();
		this.heartbeatSweep.stop();
		this.reapSweep.stop();
		this.throughput.stop();
		await this.cleanupBroadcastGroups();
		this.consumers.stopAll();
		await Promise.allSettled([this.writeClient?.close()]);
		this.writeClient = undefined;
		this.lifecycle = undefined;
	}

	async publish(topic: Topic, body: Bytes): Promise<void> {
		// No MAXLEN: trimming by count/age would drop entries a slow consumer hasn't read, breaking at-least-once.
		try {
			await this.requireWriteClient().xAdd(topic.name, "*", {
				[PAYLOAD_FIELD]: Buffer.from(body),
			});
		} catch (error) {
			throw asBrokerError(error);
		}
	}

	async consume(
		sub: Subscription,
		deliver: (msg: DeliveredMessage) => Promise<void>,
	): Promise<RunningConsumer> {
		const stream = sub.topic.name;
		const broadcast = sub.delivery === DeliveryMode.Broadcast;
		const group = this.groupFor(sub);
		await this.ensureGroup(stream, group, sub.startFrom);

		if (broadcast) {
			await this.registerBroadcastGroup(stream, group);
		}

		const readClient = createReadClient(this.options.redis);
		await readClient.connect();

		const throughput = this.createThroughput();
		throughput.start();

		const loop = new ConsumerLoop({
			topic: sub.topic,
			stream,
			group,
			broadcast,
			handler: deliver,
			readClient,
			throughput,
			brokerThroughput: this.throughput,
			options: this.options,
			writeClient: () => this.requireWriteClient(),
			probe: this.probe,
			registry: this.consumers,
		});
		this.consumers.add(loop);
		loop.start();

		return {
			stop: async () => {
				this.consumers.stop(loop);
				if (broadcast) await this.destroyBroadcastGroup(stream, group);
			},
		};
	}

	async redriveDeadLetters(opts: {
		topic: Topic;
		name: string;
	}): Promise<RedriveResult> {
		const deadStream = `${opts.topic.name}:dead:${opts.name}`;
		const redrivenKey = `flume:redriven:${deadStream}`;
		const writeClient = this.requireWriteClient();
		const readClient = createReadClient(this.options.redis);
		await readClient.connect();

		let redriven = 0;
		let skipped = 0;
		try {
			const entries = await readClient.xRange(deadStream, "-", "+");
			for (const entry of entries) {
				const deadLetter = DeadLetter.parse(bodyOf(entry.message));
				const seen = await writeClient.sIsMember(
					redrivenKey,
					deadLetter.originalId,
				);
				if (seen) {
					skipped += 1;
					continue;
				}
				await this.publish(opts.topic, deadLetter.body);
				await writeClient.sAdd(redrivenKey, deadLetter.originalId);
				redriven += 1;
			}
		} catch (error) {
			throw asBrokerError(error);
		} finally {
			await readClient.close();
		}

		const result: RedriveResult = { redriven, skipped };
		this.probe.redrove(result);
		return result;
	}

	async sampleSaturation(): Promise<BrokerSaturation> {
		const writeClient = this.requireWriteClient();
		const consumersByStream = new Map<string, ConsumerHandle[]>();
		for (const consumer of this.consumers) {
			const handles = consumersByStream.get(consumer.stream) ?? [];
			handles.push(consumer);
			consumersByStream.set(consumer.stream, handles);
		}

		const consumers: ConsumerSaturation[] = [];
		try {
			for (const [stream, handles] of consumersByStream) {
				const streamDepth = await writeClient.xLen(stream);
				const groups = await writeClient.xInfoGroups(stream);
				const byGroup = new Map(groups.map((g) => [String(g.name), g]));
				for (const consumer of handles) {
					const info = byGroup.get(consumer.group);
					consumers.push({
						stream,
						group: consumer.group,
						streamDepth,
						pendingCount: info ? Number(info.pending) : 0,
						consumerLag: info ? Number(info.lag ?? 0) : 0,
						throughputPerSecond: consumer.throughputPerSecond(),
					});
				}
			}
		} catch (error) {
			throw asBrokerError(error);
		}

		return {
			throughputPerSecond: this.throughput.perSecond(),
			consumers,
			reapSweepsSkipped: this.reapSweep.skipped,
			heartbeatSweepsSkipped: this.heartbeatSweep.skipped,
		};
	}

	private groupFor(sub: Subscription): string {
		const base = `flume:${sub.name}`;
		return sub.delivery === DeliveryMode.Broadcast
			? `${base}:${this.options.instanceId}`
			: base;
	}

	private async ensureGroup(
		stream: string,
		group: string,
		startFrom: StartFrom,
	): Promise<void> {
		const start = startFrom === "beginning" ? "0" : "$";
		try {
			await this.requireWriteClient().xGroupCreate(stream, group, start, {
				MKSTREAM: true,
			});
		} catch (error) {
			if (error instanceof Error && error.message.includes("BUSYGROUP")) {
				return;
			}
			throw asBrokerError(error);
		}
	}

	private async heartbeat(): Promise<void> {
		const writeClient = this.writeClient;
		if (writeClient === undefined) return;
		const refreshes: Promise<unknown>[] = [];
		for (const consumer of this.consumers) {
			if (!consumer.broadcast) continue;
			refreshes.push(
				writeClient.set(this.heartbeatKey(consumer.group), "1", {
					expiration: {
						type: "PX",
						value: this.options.broadcast.heartbeatTtl,
					},
				}),
			);
		}
		await Promise.all(refreshes);
	}

	private async registerBroadcastGroup(
		stream: string,
		group: string,
	): Promise<void> {
		const writeClient = this.requireWriteClient();
		// Heartbeat key written BEFORE registry SADD: a reaper racing between the two writes
		// would destroy a brand-new group if the key were absent when it checks the registry.
		await writeClient.set(this.heartbeatKey(group), "1", {
			expiration: { type: "PX", value: this.options.broadcast.heartbeatTtl },
		});
		await writeClient.sAdd(this.registryKey(stream), group);
	}

	private async reap(): Promise<void> {
		const writeClient = this.writeClient;
		if (writeClient === undefined) return;
		const streams = new Set<string>();
		for (const consumer of this.consumers) streams.add(consumer.stream);
		let groupsDestroyed = 0;
		let streamsTrimmed = 0;
		for (const stream of streams) {
			const members = await this.readRegistryPage(writeClient, stream);
			const dead = await this.destroyExpiredBroadcastGroups(
				writeClient,
				stream,
				members,
			);
			groupsDestroyed += dead.size;
			if (this.options.reaper.trim) {
				const trimmed = await this.trimStream(writeClient, stream, dead);
				if (trimmed) streamsTrimmed += 1;
			}
		}
		this.pruneRegistryCursors(streams);

		if (groupsDestroyed > 0 || streamsTrimmed > 0) {
			this.probe.reaped({ groupsDestroyed, streamsTrimmed });
		}
	}

	private async readRegistryPage(
		writeClient: WriteClient,
		stream: string,
	): Promise<string[]> {
		const cursor = this.registryCursors.get(stream) ?? "0";
		const page = await writeClient.sScan(this.registryKey(stream), cursor, {
			COUNT: REGISTRY_SCAN_COUNT,
		});

		if (page.cursor === "0") this.registryCursors.delete(stream);
		else this.registryCursors.set(stream, page.cursor);

		return page.members;
	}

	private pruneRegistryCursors(streams: ReadonlySet<string>): void {
		for (const stream of this.registryCursors.keys()) {
			if (!streams.has(stream)) this.registryCursors.delete(stream);
		}
	}

	private async destroyExpiredBroadcastGroups(
		writeClient: WriteClient,
		stream: string,
		members: readonly string[],
	): Promise<Set<string>> {
		const dead = new Set<string>();
		for (const group of members) {
			const alive = await writeClient.exists(this.heartbeatKey(group));
			if (alive > 0) continue;
			await writeClient.xGroupDestroy(stream, group);
			await writeClient.sRem(this.registryKey(stream), group);
			dead.add(group);
		}
		return dead;
	}

	private async trimStream(
		writeClient: WriteClient,
		stream: string,
		dead: Set<string>,
	): Promise<boolean> {
		const groups = await writeClient.xInfoGroups(stream);
		const live = groups.filter((group) => !dead.has(String(group.name)));
		if (live.length === 0) return false;

		const floors: string[] = [];
		for (const group of live) {
			floors.push(
				await this.groupLowWaterMark(
					writeClient,
					stream,
					String(group.name),
					String(group["last-delivered-id"]),
				),
			);
		}
		await writeClient.xTrim(stream, "MINID", minStreamId(floors));
		return true;
	}

	private async groupLowWaterMark(
		writeClient: WriteClient,
		stream: string,
		group: string,
		lastDeliveredId: string,
	): Promise<string> {
		const pending = await writeClient.xPending(stream, group);
		if (pending.pending > 0 && pending.firstId !== null) {
			return String(pending.firstId);
		}
		return lastDeliveredId;
	}

	private async cleanupBroadcastGroups(): Promise<void> {
		if (this.writeClient === undefined) return;
		for (const consumer of this.consumers) {
			if (!consumer.broadcast) continue;
			await this.destroyBroadcastGroup(consumer.stream, consumer.group).catch(
				() => {},
			);
		}
	}

	private async destroyBroadcastGroup(
		stream: string,
		group: string,
	): Promise<void> {
		const writeClient = this.requireWriteClient();
		await writeClient.xGroupDestroy(stream, group);
		await writeClient.sRem(this.registryKey(stream), group);
		await writeClient.del(this.heartbeatKey(group));
	}

	private registryKey(stream: string): string {
		return `flume:bcast:${stream}`;
	}

	private heartbeatKey(group: string): string {
		return `flume:hb:${group}`;
	}

	private requireWriteClient(): WriteClient {
		if (this.writeClient === undefined) throw new BrokerNotConnectedError();
		return this.writeClient;
	}
}
