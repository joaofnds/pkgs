// Benchmark system adapters: a uniform interface over Flume and BullMQ so the
// matrix runner treats them identically. Each system owns its own connections,
// runs a persistent consumer set up once (not timed), and exposes runBatch() —
// publish `count` messages and resolve when all are processed.
import { Worker as BullWorker, Job, Queue } from "bullmq";
import { createClient } from "redis";
import { DeliveryMode, RetryPolicy, Subscription, Topic } from "../src/index";
import { RedisStreamsBroker } from "../src/redis";

export interface Variant {
	readonly count: number;
	readonly payload: number;
	readonly concurrency: number;
	readonly mode: "competing" | "broadcast";
}

export interface BenchSystem {
	readonly name: string;
	setup(variant: Variant): Promise<void>;
	// Publish variant.count messages and resolve once all are processed. When
	// collectLatency is true, each message carries a send timestamp and the
	// dispatch->process delay (ms) is recorded.
	runBatch(collectLatency: boolean): Promise<void>;
	takeLatencies(): number[];
	teardown(): Promise<void>;
}

const HOUR = 3_600_000;

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function stamped(size: number): Buffer {
	const buf = Buffer.alloc(Math.max(size, 8), 1);
	buf.writeDoubleLE(performance.now(), 0);
	return buf;
}

function readStamp(body: Uint8Array): number {
	return new DataView(body.buffer, body.byteOffset, body.byteLength).getFloat64(
		0,
		true,
	);
}

let topicSeq = 0;

export class FlumeSystem implements BenchSystem {
	readonly name = "flume";
	private broker!: RedisStreamsBroker;
	private trimmer!: ReturnType<typeof createClient>;
	private topic!: Topic;
	private variant!: Variant;
	private readonly shared: Buffer;
	private processed = 0;
	private collect = false;
	private latencies: number[] = [];
	private done = deferred();

	constructor(
		private readonly url: string,
		payloadCeiling: number,
	) {
		this.shared = Buffer.alloc(Math.max(payloadCeiling, 8), 1);
	}

	async setup(variant: Variant): Promise<void> {
		this.variant = variant;
		this.broker = new RedisStreamsBroker({
			redis: { url: this.url },
			readTimeout: 50,
			readCount: variant.concurrency,
			// Background loops parked far beyond the run so they never add Redis
			// commands or steal CPU mid-measurement.
			reclaim: {
				interval: HOUR,
				minIdleTime: HOUR,
				count: 200,
				throughputThreshold: 1e9,
			},
			broadcast: { heartbeatInterval: HOUR, heartbeatTtl: 2 * HOUR },
			reaper: { interval: HOUR, trim: false },
		});
		await this.broker.connect();
		this.trimmer = createClient({ url: this.url });
		await this.trimmer.connect();
		this.topic = new Topic(`bench.flume.${topicSeq++}`);
		const sub = new Subscription({
			topic: this.topic,
			name: "b",
			handler: { async handle() {} },
			retry: new RetryPolicy({ maxAttempts: 1 }),
			delivery:
				variant.mode === "broadcast"
					? DeliveryMode.Broadcast
					: DeliveryMode.Competing,
			startFrom: "new",
		});
		await this.broker.consume(sub, async (msg) => {
			if (this.collect)
				this.latencies.push(performance.now() - readStamp(msg.body));
			await msg.ack();
			if (++this.processed === this.variant.count) this.done.resolve();
		});
	}

	async runBatch(collectLatency: boolean): Promise<void> {
		this.collect = collectLatency;
		this.processed = 0;
		this.latencies = [];
		this.done = deferred();
		const { count, payload } = this.variant;
		await Promise.all(
			Array.from({ length: count }, () =>
				this.broker.publish(
					this.topic,
					collectLatency ? stamped(payload) : this.shared,
				),
			),
		);
		await this.done.promise;
		// Bound the stream: acked entries stay in it until trimmed, so without
		// this, warmup+samples pile GBs onto one stream across mitata iterations.
		// Bench hygiene (one approx-trim per batch), not Flume's production behavior.
		await this.trimmer.sendCommand([
			"XTRIM",
			this.topic.name,
			"MAXLEN",
			"~",
			"1000",
		]);
	}

	takeLatencies(): number[] {
		const taken = this.latencies;
		this.latencies = [];
		return taken;
	}

	async teardown(): Promise<void> {
		await this.broker.close();
		await this.trimmer.close();
	}
}

export class BullSystem implements BenchSystem {
	readonly name = "bullmq";
	private queue!: Queue;
	private worker!: BullWorker;
	private variant!: Variant;
	private processed = 0;
	private collect = false;
	private latencies: number[] = [];
	private done = deferred();

	constructor(private readonly connection: { host: string; port: number }) {}

	async setup(variant: Variant): Promise<void> {
		this.variant = variant;
		this.queue = new Queue("bench.bullmq", {
			connection: this.connection,
			defaultJobOptions: { removeOnComplete: true, removeOnFail: true },
		});
		await this.queue.obliterate({ force: true }).catch(() => {});
		this.worker = new BullWorker(
			"bench.bullmq",
			async (job: Job<{ t?: number; pad: string }>) => {
				if (this.collect && job.data.t !== undefined) {
					this.latencies.push(performance.now() - job.data.t);
				}
				if (++this.processed === this.variant.count) this.done.resolve();
			},
			{ connection: this.connection, concurrency: variant.concurrency },
		);
		await this.worker.waitUntilReady();
	}

	async runBatch(collectLatency: boolean): Promise<void> {
		this.collect = collectLatency;
		this.processed = 0;
		this.latencies = [];
		this.done = deferred();
		const pad = "x".repeat(this.variant.payload);
		const jobs = Array.from({ length: this.variant.count }, () => ({
			name: "job",
			data: collectLatency ? { t: performance.now(), pad } : { pad },
		}));
		await this.queue.addBulk(jobs);
		await this.done.promise;
	}

	takeLatencies(): number[] {
		const taken = this.latencies;
		this.latencies = [];
		return taken;
	}

	async teardown(): Promise<void> {
		await this.worker.close();
		await this.queue.obliterate({ force: true }).catch(() => {});
		await this.queue.close();
	}
}
