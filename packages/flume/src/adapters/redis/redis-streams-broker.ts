import { Throughput } from "@joaofnds/throughput";
import {
	DeadLetter,
	DeliveryMode,
	StartFrom,
	Subscription,
	Topic,
} from "../../domain";
import { Broker, Bytes, DeliveredMessage, RunningConsumer } from "../../ports";
import {
	createReadClient,
	createWriteClient,
	ReadClient,
	WriteClient,
} from "./clients";
import { RedisDeliveredMessage } from "./delivered-message";
import { asBrokerError, BrokerError, isClientClosedError } from "./errors";
import {
	RedisStreamsBrokerOptions,
	ResolvedOptions,
	resolveOptions,
} from "./options";
import { minStreamId } from "./stream-id";

// The single stream field that carries the framed envelope bytes. The envelope
// (version + dispatchedAt + payload) is already a self-contained binary frame at
// the port, so the adapter stores it whole under one field rather than splitting
// it across stream fields.
const PAYLOAD_FIELD = "payload";

export class BrokerNotConnectedError extends BrokerError {
	constructor() {
		super("broker is not connected; call connect() before use");
		this.name = "BrokerNotConnectedError";
	}
}

// Outcome of a dead-letter redrive pass.
export interface RedriveResult {
	// Original messages re-published to the live topic this pass.
	readonly redriven: number;
	// Entries skipped because their originalId was already redriven before.
	readonly skipped: number;
}

// One running blocking-read loop, bound to a single subscription's consumer
// group. Each subscription monopolizes its own read connection (a blocking
// XREADGROUP holds the socket), so this is `subscriptions + 2` connections per
// instance — the connection-cost ceiling called out in PRD §9.
interface ConsumerState {
	readonly topic: Topic;
	readonly stream: string;
	readonly group: string;
	// Broadcast groups are per-instance and ephemeral: they heartbeat a TTL key and
	// are reaped when the instance dies. Competing groups are shared and stable, so
	// they neither heartbeat nor get reaped.
	readonly broadcast: boolean;
	readonly deliver: (msg: DeliveredMessage) => Promise<void>;
	readonly readClient: ReadClient;
	stopped: boolean;
}

// Redis Streams broker: implements both halves of the broker port (Publisher +
// Consumer) over plain native Stream commands — XADD / XREADGROUP / XACK /
// XAUTOCLAIM / XPENDING / XGROUP / XINFO / XTRIM. No server-side scripting (no
// EVAL/Lua, no MULTI): the motivating constraint (PRD §1). Three kinds of client
// mirror streams-connector: a dedicated blocking-read client per subscription,
// one shared reclaim client, one shared write/control client.
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

	// Connect the shared clients and start the periodic loops. Outside the broker
	// port (the port is just publish/consume) so the owning process controls the
	// lifecycle: connect() before worker.start(), close() on shutdown.
	async connect(): Promise<void> {
		this.writeClient = createWriteClient(this.options.redis);
		this.reclaimClient = createReadClient(this.options.redis);
		await Promise.all([
			this.writeClient.connect(),
			this.reclaimClient.connect(),
		]);
		this.throughput.start();
		this.reclaimTimer = setInterval(() => {
			this.reclaim().catch(() => {
				// Reclaim is periodic and self-healing: a failed pass (e.g. a closed
				// client mid-shutdown) is retried on the next interval.
			});
		}, this.options.reclaim.interval);
		this.heartbeatTimer = setInterval(() => {
			this.heartbeat().catch(() => {
				// Self-healing like reclaim: a missed heartbeat is refreshed next tick,
				// and the TTL is sized well above the interval to tolerate a miss.
			});
		}, this.options.broadcast.heartbeatInterval);
		this.reaperTimer = setInterval(() => {
			this.reap().catch(() => {
				// Self-healing: a failed reap pass is retried on the next interval.
			});
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
		// Graceful broadcast teardown: destroy this instance's per-instance groups so
		// they don't linger as orphans until the reaper's TTL expires. A crash skips
		// this — the reaper is the backstop (PRD §8).
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
		// No MAXLEN on a live topic stream: trimming by age/count would drop entries
		// a slow consumer group has not read yet, breaking at-least-once. Bounded
		// growth is handled by the opt-in MINID reaper instead (PRD §8).
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
			// Register the group and prove liveness BEFORE the first read, so a reaper
			// pass running between now and the first heartbeat tick can't mistake this
			// brand-new group for an orphan and destroy it.
			await this.registerBroadcastGroup(stream, group);
		}

		const readClient = createReadClient(this.options.redis);
		await readClient.connect();

		const state: ConsumerState = {
			topic: sub.topic,
			stream,
			group,
			broadcast,
			deliver,
			readClient,
			stopped: false,
		};
		this.consumers.add(state);
		this.readLoop(state);

		return {
			stop: async () => {
				state.stopped = true;
				this.consumers.delete(state);
				if (broadcast) await this.destroyBroadcastGroup(stream, group);
				// destroy(), not close(): a blocking XREADGROUP holds the socket until
				// its timeout; destroy force-closes so the loop unblocks now.
				state.readClient.destroy();
			},
		};
	}

	// Re-publish dead-lettered messages back onto their live topic. Reads the
	// per-handler dead stream `{topic}:dead:{name}`, parses each DeadLetter frame,
	// and publishes the ORIGINAL envelope bytes to `topic` — so the Worker consumes
	// them fresh (deliveryCount 1). Idempotent on `originalId`: an id already
	// redriven is skipped, so re-running after a partial pass never double-drives.
	// `name` is the full subscription name (namespace-folded, as registered), the
	// same value the dead stream key was built from. Publish happens before the
	// idempotency mark, so a crash between the two re-drives next run (at-least-once,
	// idempotent handlers) rather than silently dropping the message.
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

	// The consumer group: `flume:{sub.name}` for competing (shared → load splits),
	// `flume:{sub.name}:{instanceId}` for broadcast (per-instance → every instance
	// sees every message). sub.name already carries the namespace (the facade folded
	// it in), so the adapter only prefixes `flume:` and stays namespace-agnostic
	// (PRD §8).
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
		// "new" → `$` (only events after the group is created); "beginning" → `0`
		// (replay history). MKSTREAM creates the stream if the topic has no events
		// yet. BUSYGROUP means the group already exists — idempotent by design.
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
					for (const raw of stream.messages) {
						this.throughput.hit();
						// A fresh XREADGROUP read is attempt 1 by definition — no extra
						// round-trip to learn the count (PRD §7/§8).
						await this.deliver(state, idOf(raw.id), bodyOf(raw.message), 1);
					}
				}
			} catch (error) {
				if (state.stopped || isClientClosedError(error)) return;
				// Transient driver error (e.g. a reconnect): node-redis re-queues the
				// next read after reconnection, so loop rather than tear down.
			}
		}
	}

	// Periodic reclaim of messages idle past minIdleTime. Non-JUSTID XAUTOCLAIM
	// increments the delivery count as it claims, then XPENDING reports the
	// authoritative count — the only occasion the count is meaningful (PRD §8).
	// The Worker, not the adapter, decides dead-letter from that count.
	private async reclaim(): Promise<void> {
		const reclaimClient = this.reclaimClient;
		if (reclaimClient === undefined || !this.shouldReclaim()) return;

		for (const state of this.consumers) {
			if (state.stopped) continue;
			await this.reclaimStream(reclaimClient, state);
		}
	}

	// Sweep one consumer group's whole pending set. A single XAUTOCLAIM only scans
	// COUNT entries from its start cursor and returns `nextId` to continue from;
	// always starting at "0" re-touches the head of the PEL forever and starves the
	// tail of a large failing backlog. Follow `nextId` until it wraps to "0-0" so
	// the entire backlog is reached each pass. Per-entry minIdleTime and the
	// pass-level throughput gate (shouldReclaim) still bound what a sweep claims, so
	// it never steals more in-flight work than a single claim would. The cost is
	// O(PEL) round-trips per pass on the dedicated reclaim connection; a hot stream
	// can only grow its PEL by reading above throughputThreshold, which closes the
	// gate, so a large non-idle PEL is not swept every interval.
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
			// Under the read client's blob→Buffer mapping the cursor decodes to a
			// Buffer (like message ids); normalize so the "0-0" terminator compares.
			cursor = idOf(claim.nextId);
		} while (cursor !== "0-0");
	}

	// Slow-but-healthy mitigation: only reclaim when this instance is underloaded.
	// A saturated consumer leaves pending messages for idler siblings rather than
	// stealing (and inflating the count of) work that is merely in-flight (PRD §8).
	private shouldReclaim(): boolean {
		return (
			this.throughput.perSecond() < this.options.reclaim.throughputThreshold
		);
	}

	// Refresh the liveness key for every broadcast group this instance owns. Redis
	// expires the key on its own (server-side TTL), so the reaper's death test needs
	// no client clock and is immune to cross-instance clock skew.
	private async heartbeat(): Promise<void> {
		const writeClient = this.writeClient;
		if (writeClient === undefined) return;
		// Refresh concurrently: a slow SET on one group must not delay the others in
		// the same tick and let their TTL lapse under the reaper.
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
		// Liveness key BEFORE registry membership: the reaper reaps a registry member
		// whose heartbeat is missing, so a group must never be visible in the registry
		// without its heartbeat already present — otherwise a reaper racing between the
		// two writes would destroy a brand-new group.
		await writeClient.set(this.heartbeatKey(group), "1", {
			expiration: { type: "PX", value: this.options.broadcast.heartbeatTtl },
		});
		await writeClient.sAdd(this.registryKey(stream), group);
	}

	// Periodic reaper (PRD §8): for every stream this instance consumes, destroy
	// expired broadcast groups, then — only when trimming is enabled — XTRIM the
	// stream by the min low-water-mark across the LIVE groups. Dead broadcast groups
	// are reaped FIRST so a frozen orphan can't pin the trim point.
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

	// Destroy broadcast groups whose instance stopped heartbeating (TTL key gone),
	// returning the destroyed group names so the trim step excludes them. Competing
	// groups never appear in the registry, so they are never touched. XGROUP DESTROY
	// and SREM are both idempotent, so racing instances reaping the same orphan is
	// harmless — no Lua/transaction needed.
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

	// Trim a live topic stream to the minimum low-water-mark across its live groups
	// (PRD §8). The per-group low-water-mark is its oldest UNACKED pending id when it
	// has pending entries, else its last-delivered id — never above what a group
	// still needs, which keeps at-least-once intact even for a slow handler whose
	// entry is delivered-but-not-yet-acked. Excludes the just-reaped dead groups so a
	// frozen orphan can't freeze trimming.
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
			await this.destroyBroadcastGroup(state.stream, state.group).catch(() => {
				// Best-effort on shutdown: the reaper destroys it later via TTL if this
				// fails, so a teardown error must not block close().
			});
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
		// We only call this for a message XAUTOCLAIM just claimed, so it is always
		// in the PEL with count ≥ 2. The fallback is unreachable in practice; if a
		// concurrent ack ever emptied the range, treating it as a fresh delivery is
		// the at-least-once-safe choice (re-run, don't wrongly dead-letter).
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
			() => this.ack(state, id),
		);
		await state.deliver(message);
	}

	private async ack(state: ConsumerState, id: string): Promise<void> {
		try {
			await this.requireWriteClient().xAck(state.stream, state.group, id);
		} catch (error) {
			throw asBrokerError(error);
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

// Required, not defensive: in RESP2 every bulk reply is a BLOB_STRING, so under
// the blob→Buffer type mapping the message id ("1718-0") genuinely decodes to a
// Buffer (verified: `Buffer.isBuffer(id) === true`). Normalize it back to the
// ASCII string the port — and DeadLetter.originalId — expects.
function idOf(id: Buffer | string): string {
	return id.toString();
}

// The payload field decodes to a Buffer (binary-clean). Buffer is a Uint8Array,
// which is exactly the port's `Bytes`.
function bodyOf(message: Record<string, Buffer>): Bytes {
	const body = message[PAYLOAD_FIELD];
	if (body === undefined) {
		throw new BrokerError(
			`stream message is missing the "${PAYLOAD_FIELD}" field`,
		);
	}
	return body;
}
