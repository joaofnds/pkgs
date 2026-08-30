import { setTimeout as sleep } from "node:timers/promises";
import { Bytes, DeliveredMessage, Topic } from "@joaofnds/flume";
import { Throughput } from "@joaofnds/throughput";
import { AckBatch } from "./ack-batch";
import { BrokerProbe } from "./broker-probe";
import { createReadClient, ReadClient, WriteClient } from "./clients";
import { ConsumerHandle, ConsumerRegistry } from "./consumer-registry";
import { RedisDeliveredMessage } from "./delivered-message";
import {
	asBrokerError,
	isClientClosedError,
	isNoGroupError,
	isReadDeadlineError,
} from "./errors";
import { ResolvedOptions } from "./options";
import { ReadDeadlineError } from "./read-deadline-error";
import { bodyOf, idOf } from "./stream-message";

const READ_BACKOFF_STEP = 50;
const READ_BACKOFF_JITTER = 200;
const READ_DEADLINE_GRACE = 5000;

export class ConsumerLoop implements ConsumerHandle {
	private readonly topic: Topic;
	readonly stream: string;
	readonly group: string;
	readonly broadcast: boolean;
	private readonly handler: (msg: DeliveredMessage) => Promise<void>;
	private readClient: ReadClient;
	private readonly throughput: Throughput;
	private stopped = false;
	private readClientAborted = false;
	private consecutiveReadFailures = 0;
	private reclaimCursor = "0";
	private lastReclaimAt = 0;
	private ackBatch = new AckBatch();

	private readonly options: ResolvedOptions;
	private readonly writeClient: () => WriteClient;
	private readonly brokerThroughput: Throughput;
	private readonly probe: BrokerProbe;
	private readonly registry: ConsumerRegistry;

	constructor(props: {
		topic: Topic;
		stream: string;
		group: string;
		broadcast: boolean;
		handler: (msg: DeliveredMessage) => Promise<void>;
		readClient: ReadClient;
		throughput: Throughput;
		brokerThroughput: Throughput;
		options: ResolvedOptions;
		writeClient: () => WriteClient;
		probe: BrokerProbe;
		registry: ConsumerRegistry;
	}) {
		this.topic = props.topic;
		this.stream = props.stream;
		this.group = props.group;
		this.broadcast = props.broadcast;
		this.handler = props.handler;
		this.readClient = props.readClient;
		this.throughput = props.throughput;
		this.brokerThroughput = props.brokerThroughput;
		this.options = props.options;
		this.writeClient = props.writeClient;
		this.probe = props.probe;
		this.registry = props.registry;
	}

	start(): void {
		this.readLoop();
	}

	private async readLoop(): Promise<void> {
		while (!this.stopped) {
			if (this.readClientAborted) {
				try {
					await this.replaceReadClient();
				} catch (error) {
					if (this.stopsConsumer(error)) return;
					await this.stallConsumer(error);
					continue;
				}
			}

			try {
				await this.reclaimTurn();
			} catch (error) {
				if (this.stopsConsumer(error)) return;
				if (isReadDeadlineError(error)) {
					await this.stallConsumer(error);
					continue;
				}
				this.probe.reclaimFailed(error);
				if (this.readClientAborted) continue;
			}

			try {
				await this.readTurn();
				this.consecutiveReadFailures = 0;
			} catch (error) {
				if (this.stopsConsumer(error)) return;
				await this.stallConsumer(error);
			}
		}
	}

	// The deadline is armed around an awaited read-client command and cleared when
	// it settles, so it never spans handler dispatch: both turns await their command
	// before Promise.all(deliver), and acks leave on the write client.
	private async withReadDeadline<T>(
		operation: string,
		work: (client: ReadClient) => Promise<T>,
	): Promise<T> {
		const deadline = this.readDeadline();
		const client = this.client();
		let timer: NodeJS.Timeout | undefined;

		try {
			// Promise.race, not a bare void: an abandoned promise with no handler
			// becomes an unhandled rejection when its client is destroyed.
			return await Promise.race([
				work(client),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(
						() => reject(new ReadDeadlineError(operation, deadline)),
						deadline,
					);
				}),
			]);
		} catch (error) {
			// destroy() after the race settles: destroying first would reject the
			// in-flight command with DisconnectsClientError and win the race with it.
			if (isReadDeadlineError(error)) this.abortReadClient(client);
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}

	private readDeadline(): number {
		return this.options.readTimeout + READ_DEADLINE_GRACE;
	}

	private abortReadClient(client: ReadClient): void {
		this.readClientAborted = true;
		if (client.isOpen) client.destroy();
	}

	private async replaceReadClient(): Promise<void> {
		const client = createReadClient(this.options.redis);
		// Assigned before the await so a concurrent stop can destroy a client that
		// is still connecting.
		this.readClient = client;
		await this.withReadDeadline("connect", (fresh) => fresh.connect());

		// connect() resolves on a client destroyed mid-connect, so isOpen is what
		// says the replacement succeeded. ReadDeadlineError, never ClientClosedError:
		// the latter would route through stopsConsumer and stop a recoverable consumer.
		if (!client.isOpen) {
			this.abortReadClient(client);
			throw new ReadDeadlineError("connect", this.readDeadline());
		}
		this.readClientAborted = false;
	}

	private async readTurn(): Promise<void> {
		const response = await this.withReadDeadline("xReadGroup", (client) =>
			client.xReadGroup(
				this.group,
				this.options.consumerName,
				[{ key: this.stream, id: ">" }],
				{ BLOCK: this.options.readTimeout, COUNT: this.options.readCount },
			),
		);
		if (!response) return;

		for (const stream of response) {
			// Concurrent dispatch so the batch's acks coalesce into one multi-id XACK
			// (scheduleAck); a sequential `await` per message un-coalesces them and regresses throughput.
			await Promise.all(
				stream.messages.map((raw) => {
					this.brokerThroughput.hit();
					this.throughput.hit();
					return this.deliver(idOf(raw.id), bodyOf(raw.message), 1);
				}),
			);
		}
	}

	private async stallConsumer(error: unknown): Promise<void> {
		this.consecutiveReadFailures += 1;

		if (this.consecutiveReadFailures > 1) {
			this.probe.consumerStalled({
				stream: this.stream,
				group: this.group,
				consecutive: this.consecutiveReadFailures,
				error,
			});
		}

		await sleep(this.readBackoff(this.consecutiveReadFailures));
	}

	private stopsConsumer(error: unknown): boolean {
		if (this.stopped) return true;
		if (!isClientClosedError(error) && !isNoGroupError(error)) return false;

		this.registry.stop(this);
		this.probe.consumerStopped({
			stream: this.stream,
			group: this.group,
			error,
		});
		return true;
	}

	private async reclaimTurn(): Promise<void> {
		const now = Date.now();
		if (now - this.lastReclaimAt < this.options.reclaim.interval) return;
		if (!this.shouldReclaim()) return;

		this.lastReclaimAt = now;
		const claim = await this.withReadDeadline("xAutoClaim", (client) =>
			client.xAutoClaim(
				this.stream,
				this.group,
				this.options.consumerName,
				this.options.reclaim.minIdleTime,
				this.reclaimCursor,
				{ COUNT: this.options.readCount },
			),
		);
		// idOf() normalizes the Buffer cursor so the "0-0" terminator compares (raw compare would loop forever).
		const nextCursor = idOf(claim.nextId);
		this.reclaimCursor = nextCursor === "0-0" ? "0" : nextCursor;

		const pending = claim.messages.filter((raw) => raw !== null);
		if (pending.length === 0) return;

		const claimed = await this.withReadDeadline("xPendingRange", (client) =>
			Promise.all(
				pending.map(async (raw) => {
					const id = idOf(raw.id);
					return {
						id,
						body: bodyOf(raw.message),
						count: await this.deliveryCount(client, id),
					};
				}),
			),
		);
		await Promise.all(
			claimed.map((msg) => this.deliver(msg.id, msg.body, msg.count)),
		);

		this.probe.reclaimed(claimed.length);
	}

	private client(): ReadClient {
		return this.readClient;
	}

	throughputPerSecond(): number {
		return this.throughput.perSecond();
	}

	stop(): void {
		this.stopped = true;
		this.throughput.stop();
		if (this.readClient.isOpen) this.readClient.destroy();
	}

	private readBackoff(consecutive: number): number {
		const delay = Math.min(
			2 ** consecutive * READ_BACKOFF_STEP,
			this.options.readTimeout,
		);

		return delay + Math.floor(Math.random() * READ_BACKOFF_JITTER);
	}

	private async deliveryCount(client: ReadClient, id: string): Promise<number> {
		const pending = await client.xPendingRange(
			this.stream,
			this.group,
			id,
			id,
			1,
		);
		return pending.length > 0 ? pending[0].deliveriesCounter : 1;
	}

	private async deliver(
		id: string,
		body: Bytes,
		deliveryCount: number,
	): Promise<void> {
		const message = new RedisDeliveredMessage(
			this.topic,
			id,
			body,
			deliveryCount,
			() => this.scheduleAck(id),
		);
		await this.handler(message);
	}

	// Two foot-guns in this ack-coalescing pair: (1) the flush is a microtask, not a
	// Promise.all-completion callback — handlers await their own ack inside the read
	// loop's Promise.all, so flushing after it deadlocks; the microtask fires while they
	// are parked. (2) flushAcks swaps in a fresh batch BEFORE awaiting, so acks landing
	// mid-XACK coalesce into the next batch, not a list already in flight.
	private scheduleAck(id: string): Promise<void> {
		const batch = this.ackBatch;
		if (batch.isEmpty()) {
			queueMicrotask(() => this.flushAcks());
		}
		return batch.add(id);
	}

	private async flushAcks(): Promise<void> {
		const batch = this.ackBatch;
		this.ackBatch = new AckBatch();
		try {
			await this.writeClient().xAck(this.stream, this.group, batch.ids);
			batch.resolve();
		} catch (error) {
			batch.reject(asBrokerError(error));
		}
	}

	private shouldReclaim(): boolean {
		return (
			this.throughput.perSecond() < this.options.reclaim.throughputThreshold
		);
	}
}
