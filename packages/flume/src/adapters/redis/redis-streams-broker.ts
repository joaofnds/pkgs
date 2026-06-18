import { Throughput } from "@joaofnds/throughput";
import { DeliveryMode, StartFrom, Subscription, Topic } from "../../domain";
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

// The single stream field that carries the framed envelope bytes. The envelope
// (version + dispatchedAt + payload) is already a self-contained binary frame at
// the port, so the adapter stores it whole under one field rather than splitting
// it across stream fields.
const PAYLOAD_FIELD = "payload";

export class BroadcastNotSupportedError extends BrokerError {
	constructor(readonly name: string) {
		super(
			`broadcast delivery is not supported yet (subscription "${name}"); use Competing`,
		);
		this.name = "BroadcastNotSupportedError";
	}
}

export class BrokerNotConnectedError extends BrokerError {
	constructor() {
		super("broker is not connected; call connect() before use");
		this.name = "BrokerNotConnectedError";
	}
}

// One running blocking-read loop, bound to a single subscription's consumer
// group. Each subscription monopolizes its own read connection (a blocking
// XREADGROUP holds the socket), so this is `subscriptions + 2` connections per
// instance — the connection-cost ceiling called out in PRD §9.
interface ConsumerState {
	readonly topic: Topic;
	readonly stream: string;
	readonly group: string;
	readonly deliver: (msg: DeliveredMessage) => Promise<void>;
	readonly readClient: ReadClient;
	stopped: boolean;
}

// Redis Streams broker: implements both halves of the broker port (Publisher +
// Consumer) over plain native Stream commands — XADD / XREADGROUP / XACK /
// XAUTOCLAIM / XPENDING / XGROUP. No server-side scripting (no EVAL/Lua, no
// MULTI): the motivating constraint (PRD §1). Three kinds of client mirror
// streams-connector: a dedicated blocking-read client per subscription, one
// shared reclaim client, one shared write client.
export class RedisStreamsBroker implements Broker {
	private readonly options: ResolvedOptions;
	private readonly throughput: Throughput;
	private writeClient?: WriteClient;
	private reclaimClient?: ReadClient;
	private reclaimTimer?: ReturnType<typeof setInterval>;
	private readonly consumers = new Set<ConsumerState>();

	constructor(
		options: RedisStreamsBrokerOptions,
		throughput: Throughput = new Throughput(60, 1000),
	) {
		this.options = resolveOptions(options);
		this.throughput = throughput;
	}

	// Connect the shared clients and start the reclaim loop. Outside the broker
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
	}

	async close(): Promise<void> {
		if (this.reclaimTimer !== undefined) {
			clearInterval(this.reclaimTimer);
			this.reclaimTimer = undefined;
		}
		this.throughput.stop();
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
		// a slow consumer group has not read yet, breaking at-least-once (PRD §8).
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
		if (sub.delivery === DeliveryMode.Broadcast) {
			throw new BroadcastNotSupportedError(sub.name);
		}

		const stream = sub.topic.name;
		const group = this.groupFor(sub);
		await this.ensureGroup(stream, group, sub.startFrom);

		const readClient = createReadClient(this.options.redis);
		await readClient.connect();

		const state: ConsumerState = {
			topic: sub.topic,
			stream,
			group,
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
				// destroy(), not close(): a blocking XREADGROUP holds the socket until
				// its timeout; destroy force-closes so the loop unblocks now.
				state.readClient.destroy();
			},
		};
	}

	// The consumer group is `flume:{sub.name}`. sub.name already carries the
	// namespace (the facade folded it in), so the adapter only prefixes `flume:`
	// and stays namespace-agnostic (PRD §8).
	private groupFor(sub: Subscription): string {
		return `flume:${sub.name}`;
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
			const claim = await reclaimClient.xAutoClaim(
				state.stream,
				state.group,
				this.options.consumerName,
				this.options.reclaim.minIdleTime,
				"0",
				{ COUNT: this.options.reclaim.count },
			);
			for (const raw of claim.messages) {
				if (raw === null) continue;
				const id = idOf(raw.id);
				const count = await this.deliveryCount(state, id);
				await this.deliver(state, id, bodyOf(raw.message), count);
			}
		}
	}

	// Slow-but-healthy mitigation: only reclaim when this instance is underloaded.
	// A saturated consumer leaves pending messages for idler siblings rather than
	// stealing (and inflating the count of) work that is merely in-flight (PRD §8).
	private shouldReclaim(): boolean {
		return (
			this.throughput.perSecond() < this.options.reclaim.throughputThreshold
		);
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
