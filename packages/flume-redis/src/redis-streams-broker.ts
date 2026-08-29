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
import { AckBatch } from "./ack-batch";
import { BrokerAlreadyConnectedError } from "./broker-already-connected-error";
import { BrokerError } from "./broker-error";
import { BrokerNotConnectedError } from "./broker-not-connected-error";
import { BrokerProbe } from "./broker-probe";
import { BrokerSaturation } from "./broker-saturation";
import { ClientLifecycle } from "./client-lifecycle";
import {
	createBlockingReadClient,
	createReadClient,
	createWriteClient,
	WriteClient,
} from "./clients";
import { ConsumerSaturation } from "./consumer-saturation";
import { ConsumerState } from "./consumer-state";
import { RedisDeliveredMessage } from "./delivered-message";
import { asBrokerError, isClientClosedError, isNoGroupError } from "./errors";
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

const PAYLOAD_FIELD = "payload";
const REGISTRY_SCAN_COUNT = 100;

export class RedisStreamsBroker implements Broker {
	private readonly options: ResolvedOptions;
	private readonly throughput: Throughput;
	private readonly probe: BrokerProbe;
	private writeClient?: WriteClient;
	private readonly heartbeatSweep: MaintenanceSweep;
	private readonly reapSweep: MaintenanceSweep;
	private readonly consumers = new Set<ConsumerState>();
	private readonly registryCursors = new Map<string, string>();

	constructor(
		options: RedisStreamsBrokerOptions,
		probe: BrokerProbe = new NoopBrokerProbe(),
		throughput: Throughput = new Throughput(60, 1000),
	) {
		this.options = resolveOptions(options);
		this.throughput = throughput;
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
			new ClientLifecycle(this.probe).watch(this.writeClient);
			await this.writeClient.connect();
		} catch (error) {
			await Promise.allSettled([this.writeClient?.close()]);
			this.writeClient = undefined;
			throw error;
		}

		this.throughput.start();
		this.heartbeatSweep.start();
		this.reapSweep.start();
	}

	async close(): Promise<void> {
		this.heartbeatSweep.stop();
		this.reapSweep.stop();
		this.throughput.stop();
		await this.cleanupBroadcastGroups();
		for (const state of this.consumers) {
			state.stopped = true;
			state.readClient.destroy();
		}
		this.consumers.clear();
		await Promise.allSettled([this.writeClient?.close()]);
		this.writeClient = undefined;
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

		const readClient = createBlockingReadClient(
			this.options.redis,
			this.options.readTimeout,
		);
		await readClient.connect();

		const state: ConsumerState = {
			topic: sub.topic,
			stream,
			group,
			broadcast,
			deliver,
			readClient,
			stopped: false,
			reclaimCursor: "0",
			lastReclaimAt: 0,
			ackBatch: new AckBatch(),
		};
		this.consumers.add(state);
		this.readLoop(state);

		return {
			stop: async () => {
				state.stopped = true;
				this.consumers.delete(state);
				if (broadcast) await this.destroyBroadcastGroup(stream, group);
				state.readClient.destroy();
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
		const statesByStream = new Map<string, ConsumerState[]>();
		for (const state of this.consumers) {
			if (state.stopped) continue;
			const states = statesByStream.get(state.stream) ?? [];
			states.push(state);
			statesByStream.set(state.stream, states);
		}

		const consumers: ConsumerSaturation[] = [];
		try {
			for (const [stream, states] of statesByStream) {
				const streamDepth = await writeClient.xLen(stream);
				const groups = await writeClient.xInfoGroups(stream);
				const byGroup = new Map(groups.map((g) => [String(g.name), g]));
				for (const state of states) {
					const info = byGroup.get(state.group);
					consumers.push({
						stream,
						group: state.group,
						streamDepth,
						pendingCount: info ? Number(info.pending) : 0,
						consumerLag: info ? Number(info.lag ?? 0) : 0,
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

	private async readLoop(state: ConsumerState): Promise<void> {
		while (!state.stopped) {
			try {
				await this.reclaimTurn(state);
			} catch (error) {
				if (this.stopsConsumer(state, error)) return;
				this.probe.reclaimFailed(error);
			}

			try {
				const response = await state.readClient.xReadGroup(
					state.group,
					this.options.consumerName,
					[{ key: state.stream, id: ">" }],
					{ BLOCK: this.options.readTimeout, COUNT: this.options.readCount },
				);
				if (!response) continue;
				for (const stream of response) {
					// Concurrent dispatch so the batch's acks coalesce into one multi-id XACK
					// (scheduleAck); a sequential `await` per message un-coalesces them and regresses throughput.
					await Promise.all(
						stream.messages.map((raw) => {
							this.throughput.hit();
							return this.deliver(state, idOf(raw.id), bodyOf(raw.message), 1);
						}),
					);
				}
			} catch (error) {
				if (this.stopsConsumer(state, error)) return;
			}
		}
	}

	private stopsConsumer(state: ConsumerState, error: unknown): boolean {
		if (state.stopped || isClientClosedError(error)) return true;
		if (!isNoGroupError(error)) return false;

		state.stopped = true;
		this.probe.consumerStopped({
			stream: state.stream,
			group: state.group,
			error,
		});
		return true;
	}

	private async reclaimTurn(state: ConsumerState): Promise<void> {
		const now = Date.now();
		if (now - state.lastReclaimAt < this.options.reclaim.interval) return;
		if (!this.shouldReclaim()) return;

		state.lastReclaimAt = now;
		const claim = await state.readClient.xAutoClaim(
			state.stream,
			state.group,
			this.options.consumerName,
			this.options.reclaim.minIdleTime,
			state.reclaimCursor,
			{ COUNT: this.options.readCount },
		);
		// idOf() normalizes the Buffer cursor so the "0-0" terminator compares (raw compare would loop forever).
		const nextCursor = idOf(claim.nextId);
		state.reclaimCursor = nextCursor === "0-0" ? "0" : nextCursor;

		const pending = claim.messages.filter((raw) => raw !== null);
		if (pending.length === 0) return;

		const claimed = await Promise.all(
			pending.map(async (raw) => {
				const id = idOf(raw.id);
				return {
					id,
					body: bodyOf(raw.message),
					count: await this.deliveryCount(state, id),
				};
			}),
		);
		await Promise.all(
			claimed.map((msg) => this.deliver(state, msg.id, msg.body, msg.count)),
		);

		this.probe.reclaimed(claimed.length);
	}

	private shouldReclaim(): boolean {
		return (
			this.throughput.perSecond() < this.options.reclaim.throughputThreshold
		);
	}

	private async heartbeat(): Promise<void> {
		const writeClient = this.writeClient;
		if (writeClient === undefined) return;
		const refreshes: Promise<unknown>[] = [];
		for (const state of this.consumers) {
			if (!state.broadcast || state.stopped) continue;
			refreshes.push(
				writeClient.set(this.heartbeatKey(state.group), "1", {
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
		for (const state of this.consumers) streams.add(state.stream);
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
		for (const state of this.consumers) {
			if (!state.broadcast) continue;
			await this.destroyBroadcastGroup(state.stream, state.group).catch(
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

	private async deliveryCount(
		state: ConsumerState,
		id: string,
	): Promise<number> {
		const pending = await state.readClient.xPendingRange(
			state.stream,
			state.group,
			id,
			id,
			1,
		);
		return pending.length > 0 ? pending[0].deliveriesCounter : 1;
	}

	private async deliver(
		state: ConsumerState,
		id: string,
		body: Bytes,
		deliveryCount: number,
	): Promise<void> {
		const message = new RedisDeliveredMessage(
			state.topic,
			id,
			body,
			deliveryCount,
			() => this.scheduleAck(state, id),
		);
		await state.deliver(message);
	}

	// Two foot-guns in this ack-coalescing pair: (1) the flush is a microtask, not a
	// Promise.all-completion callback — handlers await their own ack inside the read
	// loop's Promise.all, so flushing after it deadlocks; the microtask fires while they
	// are parked. (2) flushAcks swaps in a fresh batch BEFORE awaiting, so acks landing
	// mid-XACK coalesce into the next batch, not a list already in flight.
	private scheduleAck(state: ConsumerState, id: string): Promise<void> {
		const batch = state.ackBatch;
		if (batch.isEmpty()) {
			queueMicrotask(() => this.flushAcks(state));
		}
		return batch.add(id);
	}

	private async flushAcks(state: ConsumerState): Promise<void> {
		const batch = state.ackBatch;
		state.ackBatch = new AckBatch();
		try {
			await this.requireWriteClient().xAck(
				state.stream,
				state.group,
				batch.ids,
			);
			batch.resolve();
		} catch (error) {
			batch.reject(asBrokerError(error));
		}
	}

	private requireWriteClient(): WriteClient {
		if (this.writeClient === undefined) throw new BrokerNotConnectedError();
		return this.writeClient;
	}
}

function idOf(id: Buffer | string): string {
	return id.toString();
}

function bodyOf(message: Record<string, Buffer>): Bytes {
	const body = message[PAYLOAD_FIELD];
	if (body === undefined) {
		throw new BrokerError(
			`stream message is missing the "${PAYLOAD_FIELD}" field`,
		);
	}
	return body;
}
