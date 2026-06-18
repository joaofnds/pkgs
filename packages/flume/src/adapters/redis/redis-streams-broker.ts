import { Throughput } from "@joaofnds/throughput";
import { DeadLetter } from "../../domain/dead-letter";
import { DeliveryMode } from "../../domain/delivery-mode";
import { StartFrom, Subscription } from "../../domain/subscription";
import { Topic } from "../../domain/topic";
import { Bytes } from "../../ports/codec";
import {
	Broker,
	DeliveredMessage,
	RunningConsumer,
} from "../../ports/consumer";
import { AckBatch } from "./ack-batch";
import { BrokerError } from "./broker-error";
import { BrokerNotConnectedError } from "./broker-not-connected-error";
import {
	createBlockingReadClient,
	createReadClient,
	createWriteClient,
	ReadClient,
	WriteClient,
} from "./clients";
import { ConsumerState } from "./consumer-state";
import { RedisDeliveredMessage } from "./delivered-message";
import { asBrokerError, isClientClosedError } from "./errors";
import {
	RedisStreamsBrokerOptions,
	ResolvedOptions,
	resolveOptions,
} from "./options";
import { RedriveResult } from "./redrive-result";
import { minStreamId } from "./stream-id";

const PAYLOAD_FIELD = "payload";

export class RedisStreamsBroker implements Broker {
	private readonly options: ResolvedOptions;
	private readonly throughput: Throughput;
	private writeClient?: WriteClient;
	private reclaimClient?: ReadClient;
	private reclaimTimer?: ReturnType<typeof setInterval>;
	private heartbeatTimer?: ReturnType<typeof setInterval>;
	private reaperTimer?: ReturnType<typeof setInterval>;
	private readonly consumers = new Set<ConsumerState>();

	constructor(
		options: RedisStreamsBrokerOptions,
		throughput: Throughput = new Throughput(60, 1000),
	) {
		this.options = resolveOptions(options);
		this.throughput = throughput;
	}

	async connect(): Promise<void> {
		this.writeClient = createWriteClient(this.options.redis);
		this.reclaimClient = createReadClient(this.options.redis);
		await Promise.all([
			this.writeClient.connect(),
			this.reclaimClient.connect(),
		]);
		this.throughput.start();
		this.reclaimTimer = setInterval(() => {
			this.reclaim().catch(() => {});
		}, this.options.reclaim.interval);
		this.heartbeatTimer = setInterval(() => {
			this.heartbeat().catch(() => {});
		}, this.options.broadcast.heartbeatInterval);
		this.reaperTimer = setInterval(() => {
			this.reap().catch(() => {});
		}, this.options.reaper.interval);
	}

	async close(): Promise<void> {
		for (const timer of [
			this.reclaimTimer,
			this.heartbeatTimer,
			this.reaperTimer,
		]) {
			if (timer !== undefined) clearInterval(timer);
		}
		this.reclaimTimer = undefined;
		this.heartbeatTimer = undefined;
		this.reaperTimer = undefined;
		this.throughput.stop();
		await this.cleanupBroadcastGroups();
		for (const state of this.consumers) {
			state.stopped = true;
			state.readClient.destroy();
		}
		this.consumers.clear();
		await Promise.allSettled([
			this.writeClient?.close(),
			this.reclaimClient?.close(),
		]);
		this.writeClient = undefined;
		this.reclaimClient = undefined;
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
		const readClient = this.requireReclaimClient();
		const writeClient = this.requireWriteClient();

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
		}
		return { redriven, skipped };
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
				if (state.stopped || isClientClosedError(error)) return;
			}
		}
	}

	private async reclaim(): Promise<void> {
		const reclaimClient = this.reclaimClient;
		if (reclaimClient === undefined || !this.shouldReclaim()) return;

		for (const state of this.consumers) {
			if (state.stopped) continue;
			await this.reclaimStream(reclaimClient, state);
		}
	}

	private async reclaimStream(
		reclaimClient: ReadClient,
		state: ConsumerState,
	): Promise<void> {
		let cursor = "0";
		do {
			const claim = await reclaimClient.xAutoClaim(
				state.stream,
				state.group,
				this.options.consumerName,
				this.options.reclaim.minIdleTime,
				cursor,
				{ COUNT: this.options.reclaim.count },
			);
			for (const raw of claim.messages) {
				if (state.stopped) return;
				if (raw === null) continue;
				const id = idOf(raw.id);
				const count = await this.deliveryCount(state, id);
				await this.deliver(state, id, bodyOf(raw.message), count);
			}
			// idOf() normalizes the Buffer cursor so the "0-0" terminator compares (raw compare would loop forever).
			cursor = idOf(claim.nextId);
		} while (cursor !== "0-0");
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
		for (const stream of streams) {
			const dead = await this.destroyExpiredBroadcastGroups(
				writeClient,
				stream,
			);
			if (this.options.reaper.trim) {
				await this.trimStream(writeClient, stream, dead);
			}
		}
	}

	private async destroyExpiredBroadcastGroups(
		writeClient: WriteClient,
		stream: string,
	): Promise<Set<string>> {
		const dead = new Set<string>();
		const registered = await writeClient.sMembers(this.registryKey(stream));
		for (const group of registered) {
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
	): Promise<void> {
		const groups = await writeClient.xInfoGroups(stream);
		const live = groups.filter((group) => !dead.has(String(group.name)));
		if (live.length === 0) return;

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
		const pending = await this.requireReclaimClient().xPendingRange(
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

	private requireReclaimClient(): ReadClient {
		if (this.reclaimClient === undefined) throw new BrokerNotConnectedError();
		return this.reclaimClient;
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
