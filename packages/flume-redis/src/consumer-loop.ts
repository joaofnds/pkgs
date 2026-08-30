import { Bytes, DeliveredMessage, Topic } from "@joaofnds/flume";
import { Throughput } from "@joaofnds/throughput";
import { AckBatch } from "./ack-batch";
import { ReadClient, WriteClient } from "./clients";
import { ConsumerHandle } from "./consumer-registry";
import { RedisDeliveredMessage } from "./delivered-message";
import { asBrokerError } from "./errors";
import { ResolvedOptions } from "./options";

const READ_BACKOFF_STEP = 50;
const READ_BACKOFF_JITTER = 200;

export class ConsumerLoop implements ConsumerHandle {
	readonly topic: Topic;
	readonly stream: string;
	readonly group: string;
	readonly broadcast: boolean;
	readonly handler: (msg: DeliveredMessage) => Promise<void>;
	readClient: ReadClient;
	readonly throughput: Throughput;
	stopped = false;
	readClientAborted = false;
	consecutiveReadFailures = 0;
	reclaimCursor = "0";
	lastReclaimAt = 0;
	ackBatch = new AckBatch();

	private readonly options: ResolvedOptions;
	private readonly writeClient: () => WriteClient;

	constructor(props: {
		topic: Topic;
		stream: string;
		group: string;
		broadcast: boolean;
		handler: (msg: DeliveredMessage) => Promise<void>;
		readClient: ReadClient;
		throughput: Throughput;
		options: ResolvedOptions;
		writeClient: () => WriteClient;
	}) {
		this.topic = props.topic;
		this.stream = props.stream;
		this.group = props.group;
		this.broadcast = props.broadcast;
		this.handler = props.handler;
		this.readClient = props.readClient;
		this.throughput = props.throughput;
		this.options = props.options;
		this.writeClient = props.writeClient;
	}

	throughputPerSecond(): number {
		return this.throughput.perSecond();
	}

	stop(): void {
		this.stopped = true;
		this.throughput.stop();
		if (this.readClient.isOpen) this.readClient.destroy();
	}

	readBackoff(consecutive: number): number {
		const delay = Math.min(
			2 ** consecutive * READ_BACKOFF_STEP,
			this.options.readTimeout,
		);

		return delay + Math.floor(Math.random() * READ_BACKOFF_JITTER);
	}

	async deliveryCount(client: ReadClient, id: string): Promise<number> {
		const pending = await client.xPendingRange(
			this.stream,
			this.group,
			id,
			id,
			1,
		);
		return pending.length > 0 ? pending[0].deliveriesCounter : 1;
	}

	async deliver(id: string, body: Bytes, deliveryCount: number): Promise<void> {
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

	shouldReclaim(): boolean {
		return (
			this.throughput.perSecond() < this.options.reclaim.throughputThreshold
		);
	}
}
