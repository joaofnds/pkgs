// Answers one question with numbers, not guesses: is Flume's hot path
// client-JS-bound, Redis-server-bound, or round-trip-latency-bound (client loop
// idle waiting on Redis while Redis still has headroom)? Only the last regime is
// where read/process pipelining would help; the first wants less per-message JS,
// the second wants fewer/cheaper commands. Runs the real FlumeSystem path and
// reports client event-loop utilization + process CPU against Redis server CPU.
//   pnpm --filter @joaofnds/flume bench:profile
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { createClient } from "redis";
import { fixed, num, table } from "./bench-report";
import { FlumeSystem, type Variant } from "./bench-systems";

const REDIS_URL = "redis://localhost:6381";
const VARIANT: Variant = {
	count: 10000,
	payload: 1024,
	concurrency: 200,
	mode: "competing",
};
const WARMUP = 3;
const ITERS = 12;
const SATURATED = 0.85; // cores / utilization above this counts as "the bottleneck"

interface MaintClient {
	sendCommand(args: string[]): Promise<unknown>;
	close(): Promise<unknown>;
}

async function connectMaint(): Promise<MaintClient> {
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

// Cumulative Redis server CPU seconds (user+sys). A delta over the run window
// divided by wall time gives the average cores Redis burned to sustain it.
async function redisCpuSeconds(maint: MaintClient): Promise<number> {
	const info = String(await maint.sendCommand(["INFO", "cpu"]));
	const user = Number(/used_cpu_user:([\d.]+)/.exec(info)?.[1] ?? "0");
	const sys = Number(/used_cpu_sys:([\d.]+)/.exec(info)?.[1] ?? "0");
	return user + sys;
}

function verdict(clientUtil: number, redisCores: number): string {
	if (redisCores > SATURATED) {
		return "Redis-server-bound: Redis is near one core. Lever = fewer/cheaper commands or a bigger/sharded Redis; neither client JS nor pipelining helps.";
	}
	if (clientUtil > SATURATED) {
		return "client-JS-bound: the event loop is saturated doing our work. Lever = cut per-message JS (drill in with --cpu-prof); pipelining won't help a busy loop.";
	}
	return "latency-bound: the client loop sits idle waiting on Redis while both sides have CPU headroom. Lever = pipeline reads/processing to overlap the waits; a promise-utility lib won't help.";
}

async function main(): Promise<void> {
	const maint = await connectMaint();
	const flume = new FlumeSystem(REDIS_URL, VARIANT.payload);
	await flume.setup(VARIANT);

	for (let i = 0; i < WARMUP; i++) await flume.runBatch(false);

	const elu0 = performance.eventLoopUtilization();
	const cpu0 = process.cpuUsage();
	const redis0 = await redisCpuSeconds(maint);
	const wall0 = performance.now();

	for (let i = 0; i < ITERS; i++) await flume.runBatch(false);

	const wallSec = (performance.now() - wall0) / 1000;
	const elu = performance.eventLoopUtilization(elu0);
	const cpu = process.cpuUsage(cpu0);
	const redisCores = ((await redisCpuSeconds(maint)) - redis0) / wallSec;

	await flume.teardown();
	await maint.close();

	const msgs = VARIANT.count * ITERS;
	const clientCores = (cpu.user + cpu.system) / 1e6 / wallSec;
	const rows = [
		["throughput (msg/s)", num(msgs / wallSec)],
		["client event-loop util", `${fixed(elu.utilization * 100, 1)}%`],
		["client process CPU (cores)", fixed(clientCores, 2)],
		["redis server CPU (cores)", fixed(redisCores, 2)],
		["client active µs/msg", fixed((elu.active * 1000) / msgs, 2)],
		["redis CPU µs/msg", fixed((redisCores * wallSec * 1e6) / msgs, 2)],
	];

	process.stdout.write(
		`\n## PROFILE — ${VARIANT.payload}B/${VARIANT.count}/c${VARIANT.concurrency}, ${ITERS} iters\n\n`,
	);
	process.stdout.write(`${table(["metric", "value"], rows)}\n\n`);
	process.stdout.write(`VERDICT: ${verdict(elu.utilization, redisCores)}\n`);
}

main().then(
	() => process.exit(0),
	(error) => {
		process.stderr.write(`${error?.stack ?? error}\n`);
		process.exit(1);
	},
);
