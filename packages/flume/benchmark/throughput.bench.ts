// Serious throughput/latency/ops benchmark: Flume (Redis Streams, no Lua) vs a
// BullMQ baseline, over a full parameter matrix, measured with mitata.
//
// For each variant it reports, all on the same Redis (port 6381):
//   - throughput  — msg/s from mitata's median op time (warmup + multiple samples)
//   - latency     — per-message dispatch->process p50/p95/p99 (ms), under burst load
//   - redis ops   — data-plane commands per message + Lua (EVAL/EVALSHA) calls,
//                   from CONFIG RESETSTAT + INFO commandstats (Flume's no-Lua edge)
//
// BullMQ has no native broadcast, so broadcast is a Flume-only sub-sweep
// (competing vs broadcast) to expose the broadcast code path's overhead.
//
// Out of the default test path: `pnpm --filter @joaofnds/flume bench`.
import { setTimeout as sleep } from "node:timers/promises";
import { bench, measure, run, summary } from "mitata";
import { createClient } from "redis";
import {
	fixed,
	num,
	parseCommandStats,
	percentile,
	table,
} from "./bench-report";
import {
	type BenchSystem,
	BullSystem,
	FlumeSystem,
	type Variant,
} from "./bench-systems";

const REDIS_URL = "redis://localhost:6381";
const CONNECTION = { host: "localhost", port: 6381 };

// BENCH_FAST shrinks the matrix to one representative competing variant and skips
// the broadcast sub-sweep + headline, for quick before/after iteration on a change.
const FAST = process.env.BENCH_FAST !== undefined;
const PAYLOADS = FAST ? [1024] : [64, 1024, 16384];
const COUNTS = FAST ? [10000] : [1000, 10000];
const CONCURRENCY = FAST ? [200] : [50, 200, 500];
const MAX_PAYLOAD = Math.max(...PAYLOADS);

const SAMPLES = { warmup_samples: 3, min_samples: 8, max_samples: 16 };

// Minimal surface we need from the maintenance client — decouples the matrix
// runner from node-redis's heavy RESP-pinned generic client type.
interface MaintClient {
	ping(): Promise<unknown>;
	sendCommand(args: string[]): Promise<unknown>;
}

interface VariantResult {
	readonly variant: Variant;
	readonly system: string;
	readonly msgPerSec: number;
	readonly opP99Ms: number;
	readonly latP50: number;
	readonly latP95: number;
	readonly latP99: number;
	readonly cmdsPerMsg: number;
	readonly luaPerMsg: number;
}

function progress(line: string): void {
	process.stderr.write(`${line}\n`);
}

function out(line: string): void {
	process.stdout.write(`${line}\n`);
}

// Retries the connect so `pnpm bench` (compose up -d, then immediately tsx)
// doesn't race Redis accepting connections.
async function connectMaint() {
	for (let attempt = 0; attempt < 50; attempt++) {
		const client = createClient({ url: REDIS_URL, RESP: 2 });
		try {
			await client.connect();
			return client;
		} catch {
			await client.close().catch(() => {});
			await sleep(200);
		}
	}
	throw new Error("redis not reachable on 6381");
}

async function throughput(
	system: BenchSystem,
	count: number,
): Promise<{ msgPerSec: number; opP99Ms: number }> {
	const stats = await measure(async function* () {
		yield async () => {
			await system.runBatch(false);
		};
	}, SAMPLES);
	return { msgPerSec: count / (stats.p50 / 1e9), opP99Ms: stats.p99 / 1e6 };
}

async function latencyAndOps(
	system: BenchSystem,
	variant: Variant,
	maint: MaintClient,
): Promise<
	Pick<
		VariantResult,
		"latP50" | "latP95" | "latP99" | "cmdsPerMsg" | "luaPerMsg"
	>
> {
	await maint.sendCommand(["CONFIG", "RESETSTAT"]);
	await system.runBatch(true);
	const info = String(await maint.sendCommand(["INFO", "commandstats"]));
	const stats = parseCommandStats(info);
	const lat = system.takeLatencies();
	return {
		latP50: percentile(lat, 0.5),
		latP95: percentile(lat, 0.95),
		latP99: percentile(lat, 0.99),
		cmdsPerMsg: stats.total / variant.count,
		luaPerMsg: stats.lua / variant.count,
	};
}

async function measureSystem(
	system: BenchSystem,
	variant: Variant,
	maint: MaintClient,
): Promise<VariantResult> {
	await system.setup(variant);
	const { msgPerSec, opP99Ms } = await throughput(system, variant.count);
	const tail = await latencyAndOps(system, variant, maint);
	await system.teardown();
	return { variant, system: system.name, msgPerSec, opP99Ms, ...tail };
}

function label(v: Variant): string {
	const count = v.count >= 1000 ? `${v.count / 1000}k` : `${v.count}`;
	const payload = v.payload >= 1024 ? `${v.payload / 1024}KB` : `${v.payload}B`;
	return `${payload}/${count}/c${v.concurrency}`;
}

function competingMatrix(): Variant[] {
	const variants: Variant[] = [];
	for (const payload of PAYLOADS) {
		for (const count of COUNTS) {
			for (const concurrency of CONCURRENCY) {
				variants.push({ payload, count, concurrency, mode: "competing" });
			}
		}
	}
	return variants;
}

function orderedKeys(results: VariantResult[]): string[] {
	return [...new Set(results.map((r) => label(r.variant)))];
}

function pick(
	results: VariantResult[],
	key: string,
	system: string,
): VariantResult | undefined {
	return results.find((r) => label(r.variant) === key && r.system === system);
}

function printThroughput(results: VariantResult[]): void {
	const rows: string[][] = [];
	for (const key of orderedKeys(results)) {
		const flume = pick(results, key, "flume");
		const bull = pick(results, key, "bullmq");
		if (flume === undefined || bull === undefined) continue;
		rows.push([
			key,
			num(flume.msgPerSec),
			num(bull.msgPerSec),
			`${fixed(flume.msgPerSec / bull.msgPerSec)}x`,
			fixed(flume.opP99Ms, 1),
			fixed(bull.opP99Ms, 1),
		]);
	}
	out("\n## THROUGHPUT — competing (msg/s, higher is better)\n");
	out(
		table(
			[
				"payload/count/conc",
				"flume",
				"bullmq",
				"flume×",
				"f p99 op(ms)",
				"b p99 op(ms)",
			],
			rows,
		),
	);
}

function printLatency(results: VariantResult[]): void {
	const rows: string[][] = [];
	for (const key of orderedKeys(results)) {
		const flume = pick(results, key, "flume");
		const bull = pick(results, key, "bullmq");
		if (flume === undefined || bull === undefined) continue;
		rows.push([
			key,
			fixed(flume.latP50),
			fixed(flume.latP95),
			fixed(flume.latP99),
			fixed(bull.latP50),
			fixed(bull.latP95),
			fixed(bull.latP99),
		]);
	}
	out(
		"\n## LATENCY — competing, dispatch→process under burst (ms, lower is better)\n",
	);
	out(
		table(
			[
				"payload/count/conc",
				"f p50",
				"f p95",
				"f p99",
				"b p50",
				"b p95",
				"b p99",
			],
			rows,
		),
	);
}

function printOps(results: VariantResult[]): void {
	const rows: string[][] = [];
	for (const key of orderedKeys(results)) {
		const flume = pick(results, key, "flume");
		const bull = pick(results, key, "bullmq");
		if (flume === undefined || bull === undefined) continue;
		rows.push([
			key,
			fixed(flume.cmdsPerMsg),
			fixed(flume.luaPerMsg),
			fixed(bull.cmdsPerMsg),
			fixed(bull.luaPerMsg),
		]);
	}
	out(
		"\n## REDIS OPS — competing, data-plane commands per message (Lua = EVAL/EVALSHA/FCALL)\n",
	);
	out(
		table(
			[
				"payload/count/conc",
				"f cmds/msg",
				"f lua/msg",
				"b cmds/msg",
				"b lua/msg",
			],
			rows,
		),
	);
}

function printBroadcast(results: VariantResult[]): void {
	const rows = results.map((r) => [
		`${label(r.variant)} ${r.variant.mode}`,
		num(r.msgPerSec),
		fixed(r.latP99),
		fixed(r.cmdsPerMsg),
	]);
	out("\n## BROADCAST — Flume only (BullMQ has no native broadcast)\n");
	out(table(["variant", "msg/s", "p99 lat(ms)", "cmds/msg"], rows));
}

// Warm V8/JIT and Redis connections before measuring so early matrix variants
// aren't penalized by cold-start relative to later ones.
async function warmup(): Promise<void> {
	const variant: Variant = {
		count: FAST ? 2000 : 5000,
		payload: 1024,
		concurrency: 200,
		mode: "competing",
	};
	const systems: BenchSystem[] = [
		new FlumeSystem(REDIS_URL, MAX_PAYLOAD),
		new BullSystem(CONNECTION),
	];
	const rounds = FAST ? 1 : 3;
	for (const system of systems) {
		await system.setup(variant);
		for (let i = 0; i < rounds; i++) await system.runBatch(false);
		await system.teardown();
	}
}

async function headline(): Promise<void> {
	const variant: Variant = {
		count: 10000,
		payload: 1024,
		concurrency: 200,
		mode: "competing",
	};
	const flume = new FlumeSystem(REDIS_URL, MAX_PAYLOAD);
	const bull = new BullSystem(CONNECTION);
	await flume.setup(variant);
	await bull.setup(variant);
	out(`\n## HEADLINE — ${label(variant)} (mitata, native output)\n`);
	summary(() => {
		bench(`flume  ${label(variant)}`, async function* () {
			yield async () => {
				await flume.runBatch(false);
			};
		});
		bench(`bullmq ${label(variant)}`, async function* () {
			yield async () => {
				await bull.runBatch(false);
			};
		});
	});
	await run();
	await flume.teardown();
	await bull.teardown();
}

async function main(): Promise<void> {
	const maint = await connectMaint();

	progress("warming up (jit + connections) …");
	await warmup();

	const variants = competingMatrix();
	const results: VariantResult[] = [];
	let done = 0;
	for (const variant of variants) {
		progress(`[${++done}/${variants.length}] competing ${label(variant)} …`);
		results.push(
			await measureSystem(
				new FlumeSystem(REDIS_URL, MAX_PAYLOAD),
				variant,
				maint,
			),
		);
		results.push(
			await measureSystem(new BullSystem(CONNECTION), variant, maint),
		);
	}

	const broadcast: VariantResult[] = [];
	if (!FAST) {
		for (const payload of PAYLOADS) {
			for (const mode of ["competing", "broadcast"] as const) {
				const variant: Variant = {
					count: 10000,
					payload,
					concurrency: 200,
					mode,
				};
				progress(`[broadcast] flume ${label(variant)} …`);
				broadcast.push(
					await measureSystem(
						new FlumeSystem(REDIS_URL, MAX_PAYLOAD),
						variant,
						maint,
					),
				);
			}
		}
	}

	printThroughput(results);
	printLatency(results);
	printOps(results);
	if (!FAST) {
		printBroadcast(broadcast);
		await headline();
	}

	await maint.close();
}

main().then(
	() => process.exit(0),
	(error) => {
		process.stderr.write(`${error?.stack ?? error}\n`);
		process.exit(1);
	},
);
