// Saturation harness: ramp concurrent producer+consumer worker threads against
// each backend until either the client (Node) or the backend (redis / nats)
// saturates its CPU, and report which. Distinct from throughput.bench.ts
// (the single-process mitata comparison) — this one is multi-core and answers
// "where is the ceiling, and who owns it".
//
// Per (system, topology, W): spawn W consumers, then W producers (consumers
// first so startFrom:new misses nothing). Producers publish flat-out; the
// orchestrator pauses them whenever the unconsumed backlog crosses a high-water
// mark, so memory stays bounded while throughput is still backend-limited. After
// a warmup, measure steady-state processed/s over a window while sampling client
// and backend CPU.
//
// Out of the default test path: `pnpm --filter @joaofnds/flume-bench bench:sat`.

import { cpus } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import {
	DeliveryMode,
	RetryPolicy,
	Subscription,
	Topic,
} from "@joaofnds/flume";
import { NatsStreamsBroker } from "@joaofnds/flume-nats";
import { connect, RetentionPolicy } from "nats";
import { createClient } from "redis";
import { fixed, num, table } from "./bench-report";
import { resolveContainer, sampleContainerCores } from "./sat-metrics";
import type { SystemKind, WorkerConfig, WorkerToMain } from "./sat-types";

const HOUR = 3_600_000;
const CORES = cpus().length;
const FAST = process.env.SAT_FAST !== undefined;

const SYSTEMS: ReadonlyArray<{
	readonly name: string;
	readonly system: SystemKind;
	readonly url: string;
	readonly service: string;
}> = [
	{
		name: "redis",
		system: "redis",
		url: "redis://localhost:6381",
		service: "redis",
	},
	{
		name: "nats",
		system: "nats",
		url: "nats://localhost:4223",
		service: "nats",
	},
];

const TOPOLOGIES = ["independent", "shared"] as const;
type Topology = (typeof TOPOLOGIES)[number];

const RAMP = uniqueAscending(
	(FAST ? [1, 4] : [1, 2, 4, 8, 12, CORES]).filter((w) => w <= CORES),
);
const PAYLOAD = 64;
const READ_COUNT = 200;
const PUB_INFLIGHT = 500;
const WARMUP_MS = FAST ? 1500 : 3000;
const MEASURE_MS = FAST ? 2500 : 5000;
const SAMPLES = FAST ? 1 : 3;
const BACKLOG_HIGH = 400_000;
const BACKLOG_LOW = 150_000;

interface Row {
	readonly W: number;
	readonly throughput: number;
	readonly clientCores: number;
	readonly backendCores: number;
	readonly bound: string;
}

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));
const epoch = (): number => performance.timeOrigin + performance.now();

function uniqueAscending(values: number[]): number[] {
	return [...new Set(values)].sort((a, b) => a - b);
}

const SATURATED = 0.7;

function saturationLabel(clientFrac: number, backendFrac: number): string {
	if (backendFrac >= SATURATED) return "backend cpu";
	if (clientFrac >= SATURATED) return "client cpu";
	return "unsaturated";
}

function progress(line: string): void {
	process.stderr.write(`${line}\n`);
}

function out(line: string): void {
	process.stdout.write(`${line}\n`);
}

class Fleet {
	private readonly workers: Worker[] = [];
	private readonly published = new Map<number, number>();
	private readonly processed = new Map<number, number>();
	private paused = false;
	private nextId = 0;

	spawn(cfg: WorkerConfig): Promise<void> {
		const id = this.nextId++;
		this.published.set(id, 0);
		this.processed.set(id, 0);
		const worker = new Worker(join(__dirname, "sat-worker.ts"), {
			execArgv: ["--import", "tsx"],
			workerData: cfg,
		});
		this.workers.push(worker);

		const ready = Promise.withResolvers<void>();
		worker.on("message", (msg: WorkerToMain) => {
			if (msg.type === "stat") {
				this.published.set(id, msg.published);
				this.processed.set(id, msg.processed);
			} else if (msg.type === "ready") {
				ready.resolve();
			} else if (msg.type === "error") {
				progress(`  worker ${id} error: ${msg.message}`);
				ready.resolve();
			}
		});
		worker.on("error", (error) => {
			progress(`  worker ${id} thread error: ${error.message}`);
			ready.resolve();
		});
		return ready.promise;
	}

	totalProcessed(): number {
		return sum(this.processed);
	}

	backlog(): number {
		return sum(this.published) - sum(this.processed);
	}

	setPaused(value: boolean): void {
		if (this.paused === value) return;
		this.paused = value;
		for (const worker of this.workers) {
			worker.postMessage({ type: value ? "pause" : "resume" });
		}
	}

	async stopAll(): Promise<void> {
		await Promise.all(
			this.workers.map((worker) => {
				const stopped = new Promise<void>((resolve) => {
					worker.on("message", (msg: WorkerToMain) => {
						if (msg.type === "stopped") resolve();
					});
				});
				worker.postMessage({ type: "stop" });
				return Promise.race([stopped, sleep(3000)]).then(() =>
					worker.terminate(),
				);
			}),
		);
	}
}

function sum(map: Map<number, number>): number {
	let total = 0;
	for (const value of map.values()) total += value;
	return total;
}

async function cleanupBackend(system: SystemKind, url: string): Promise<void> {
	if (system === "nats") {
		const nc = await connect({ servers: url });
		const jsm = await nc.jetstreamManager();
		await jsm.streams.delete("flume").catch(() => {});
		await nc.close();
		return;
	}
	const client = createClient({ url });
	await client.connect();
	await client.sendCommand(["FLUSHALL"]).catch(() => {});
	await client.close();
}

async function ensureNatsStream(url: string): Promise<void> {
	const nc = await connect({ servers: url, noAsyncTraces: true });
	const jsm = await nc.jetstreamManager();
	try {
		await jsm.streams.info("flume");
	} catch {
		await jsm.streams.add({
			name: "flume",
			subjects: ["flume.>"],
			retention: RetentionPolicy.Limits,
		});
	}
	await nc.close();
}

async function ensureNatsSharedConsumer(
	url: string,
	topic: string,
	subName: string,
): Promise<void> {
	const broker = new NatsStreamsBroker({
		nats: { servers: url },
		readCount: 1,
		ackWait: HOUR,
	});
	await broker.connect();
	const sub = new Subscription({
		topic: new Topic(topic),
		name: subName,
		handler: { async handle() {} },
		retry: new RetryPolicy({ maxAttempts: 1 }),
		delivery: DeliveryMode.Competing,
		startFrom: "new",
	});
	const running = await broker.consume(sub, async () => {});
	await running.stop();
	await broker.close();
}

function topicFor(topology: Topology, index: number): string {
	return topology === "independent" ? `sat-${index}` : "sat-shared";
}

function subNameFor(topology: Topology, topic: string): string {
	return topology === "independent" ? topic : "shared";
}

async function runStep(
	system: SystemKind,
	url: string,
	containerId: string,
	topology: Topology,
	workers: number,
): Promise<Row> {
	await cleanupBackend(system, url);
	if (system === "nats") {
		await ensureNatsStream(url);
		if (topology === "shared") {
			await ensureNatsSharedConsumer(url, "sat-shared", "shared");
		}
	}

	const fleet = new Fleet();
	for (let i = 0; i < workers; i++) {
		const topic = topicFor(topology, i);
		await fleet.spawn({
			role: "consumer",
			system,
			url,
			topic,
			subName: subNameFor(topology, topic),
			payload: PAYLOAD,
			readCount: READ_COUNT,
			pubInflight: PUB_INFLIGHT,
			consumerName: `sat-c${i}`,
		});
	}
	for (let i = 0; i < workers; i++) {
		const topic = topicFor(topology, i);
		await fleet.spawn({
			role: "producer",
			system,
			url,
			topic,
			subName: subNameFor(topology, topic),
			payload: PAYLOAD,
			readCount: READ_COUNT,
			pubInflight: PUB_INFLIGHT,
			consumerName: `sat-p${i}`,
		});
	}

	const throttle = setInterval(() => {
		const backlog = fleet.backlog();
		if (backlog > BACKLOG_HIGH) fleet.setPaused(true);
		else if (backlog < BACKLOG_LOW) fleet.setPaused(false);
	}, 100);

	await sleep(WARMUP_MS);

	const t0 = epoch();
	const cpu0 = process.cpuUsage();
	const p0 = fleet.totalProcessed();
	const sampler = (async () => {
		const cores: number[] = [];
		for (let i = 0; i < SAMPLES; i++) {
			cores.push(await sampleContainerCores(containerId));
		}
		return cores;
	})();
	await sleep(MEASURE_MS);
	const samples = await sampler;
	const t1 = epoch();
	const cpu1 = process.cpuUsage(cpu0);
	const p1 = fleet.totalProcessed();

	clearInterval(throttle);
	await fleet.stopAll();

	const wallMs = t1 - t0;
	const throughput = (p1 - p0) / (wallMs / 1000);
	const clientCores = (cpu1.user + cpu1.system) / 1000 / wallMs;
	const backendCores =
		samples.length > 0
			? samples.reduce((a, b) => a + b, 0) / samples.length
			: 0;
	// Redis runs commands on one thread, so its ceiling is ~1 core; nats is
	// multi-threaded and can spread across the box. A side is the bottleneck only
	// once it nears ITS ceiling; if neither does yet throughput has stopped
	// scaling, the limit is serialization/contention (e.g. nats's one catch-all
	// stream), not CPU — labelled "unsaturated".
	const backendCeiling = system === "redis" ? 1 : CORES;
	const bound = saturationLabel(
		clientCores / CORES,
		backendCores / backendCeiling,
	);
	return { W: workers, throughput, clientCores, backendCores, bound };
}

function printCurve(name: string, topology: Topology, rows: Row[]): void {
	out(`\n## SATURATION — ${name} / ${topology} (${PAYLOAD}B payload)\n`);
	out(
		table(
			["workers", "msg/s", "client cores", "backend cores", "bound by"],
			rows.map((r) => [
				String(r.W),
				num(r.throughput),
				fixed(r.clientCores),
				fixed(r.backendCores),
				r.bound,
			]),
		),
	);
}

function printPeaks(
	peaks: Array<{ name: string; topology: Topology; row: Row }>,
): void {
	out("\n## PEAK — best sustained throughput per system × topology\n");
	out(
		table(
			[
				"system",
				"topology",
				"peak msg/s",
				"@workers",
				"client cores",
				"backend cores",
				"bound by",
			],
			peaks.map((p) => [
				p.name,
				p.topology,
				num(p.row.throughput),
				String(p.row.W),
				fixed(p.row.clientCores),
				fixed(p.row.backendCores),
				p.row.bound,
			]),
		),
	);
}

async function main(): Promise<void> {
	progress(`cores=${CORES}  ramp=${RAMP.join(",")}  payload=${PAYLOAD}B`);
	out(
		`legend — bound by: "backend cpu" = server core ≥${SATURATED * 100}% of its ceiling (redis=1 thread, nats=${CORES}); "client cpu" = node ≥${SATURATED * 100}% of ${CORES} cores; "unsaturated" = neither, so the limit is serialization/contention or the ramp ran out.`,
	);
	const containers = new Map<string, string>();
	for (const sys of SYSTEMS)
		containers.set(sys.name, resolveContainer(sys.service));

	const peaks: Array<{ name: string; topology: Topology; row: Row }> = [];
	for (const sys of SYSTEMS) {
		const containerId = containers.get(sys.name);
		if (containerId === undefined) continue;
		for (const topology of TOPOLOGIES) {
			const rows: Row[] = [];
			let best = 0;
			let plateau = 0;
			for (const workers of RAMP) {
				progress(`[${sys.name}/${topology}] W=${workers} …`);
				const row = await runStep(
					sys.system,
					sys.url,
					containerId,
					topology,
					workers,
				);
				rows.push(row);
				if (row.throughput < best * 1.05) plateau += 1;
				else plateau = 0;
				best = Math.max(best, row.throughput);
				if (plateau >= 2) {
					progress(`  plateau reached — stopping ramp`);
					break;
				}
			}
			printCurve(sys.name, topology, rows);
			const peak = rows.reduce((a, b) => (b.throughput > a.throughput ? b : a));
			peaks.push({ name: sys.name, topology, row: peak });
		}
	}
	printPeaks(peaks);
}

main().then(
	() => process.exit(0),
	(error) => {
		process.stderr.write(`${(error as Error)?.stack ?? error}\n`);
		process.exit(1);
	},
);
