// Throughput benchmark: Flume (Redis Streams, no Lua) vs a BullMQ baseline.
//
// Tests the "leaner than Bull" hypothesis from PRD §1/§14 with numbers, not
// assertions. BullMQ drives every job-state transition through server-side Lua
// (EVAL), which serializes on Redis' single command thread under load; Flume uses
// only plain native Stream commands. This measures end-to-end dispatch→process
// throughput for each over the same Redis (port 6381).
//
// Out of the default test path: run with `pnpm --filter @joaofnds/flume bench`.
// Not a pass/fail test — it prints msgs/sec for eyeballing.

import { Throughput } from "@joaofnds/throughput";
import { Worker as BullWorker, Queue } from "bullmq";
import { RedisStreamsBroker } from "../src/adapters/redis";
import { DeliveryMode, RetryPolicy, Subscription, Topic } from "../src/index";

const REDIS_URL = "redis://localhost:6381";
const REDIS = { host: "localhost", port: 6381 };
const MESSAGE_COUNT = 10_000;
const PAYLOAD = { hello: "world", n: 0 };

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function rate(count: number, elapsedMs: number): string {
	return `${Math.round(count / (elapsedMs / 1000)).toLocaleString()} msg/s`;
}

async function benchFlume(): Promise<{ elapsed: number; peak: number }> {
	const broker = new RedisStreamsBroker({
		redis: { url: REDIS_URL },
		readTimeout: 50,
		readCount: 200,
		reclaim: {
			interval: 1000,
			minIdleTime: 30_000,
			count: 200,
			throughputThreshold: 1_000_000,
		},
	});
	await broker.connect();

	const throughput = new Throughput(10, 100);
	throughput.start();
	let peak = 0;
	const sample = setInterval(() => {
		peak = Math.max(peak, throughput.perSecond());
	}, 100);

	const topic = new Topic("bench.flume");
	const sub = new Subscription({
		topic,
		name: "bench:consumer",
		handler: { async handle() {} },
		retry: new RetryPolicy({ maxAttempts: 1 }),
		delivery: DeliveryMode.Competing,
		startFrom: "new",
	});

	let processed = 0;
	const done = deferred();
	await broker.consume(sub, async (msg) => {
		await msg.ack();
		throughput.hit();
		processed += 1;
		if (processed === MESSAGE_COUNT) done.resolve();
	});

	const body = new TextEncoder().encode(JSON.stringify(PAYLOAD));
	const start = performance.now();
	await Promise.all(
		Array.from({ length: MESSAGE_COUNT }, () => broker.publish(topic, body)),
	);
	await done.promise;
	const elapsed = performance.now() - start;

	clearInterval(sample);
	throughput.stop();
	await broker.close();
	return { elapsed, peak };
}

async function benchBullMQ(): Promise<{ elapsed: number; peak: number }> {
	const queueName = "bench.bullmq";
	const queue = new Queue(queueName, { connection: REDIS });
	await queue.obliterate({ force: true }).catch(() => {});

	const throughput = new Throughput(10, 100);
	throughput.start();
	let peak = 0;
	const sample = setInterval(() => {
		peak = Math.max(peak, throughput.perSecond());
	}, 100);

	let processed = 0;
	const done = deferred();
	const worker = new BullWorker(
		queueName,
		async () => {
			throughput.hit();
			processed += 1;
			if (processed === MESSAGE_COUNT) done.resolve();
		},
		{ connection: REDIS, concurrency: 50 },
	);
	await worker.waitUntilReady();

	const start = performance.now();
	await queue.addBulk(
		Array.from({ length: MESSAGE_COUNT }, () => ({
			name: "job",
			data: PAYLOAD,
		})),
	);
	await done.promise;
	const elapsed = performance.now() - start;

	clearInterval(sample);
	throughput.stop();
	await worker.close();
	await queue.obliterate({ force: true }).catch(() => {});
	await queue.close();
	return { elapsed, peak };
}

async function main(): Promise<void> {
	process.stdout.write(
		`Dispatching + processing ${MESSAGE_COUNT.toLocaleString()} messages each.\n\n`,
	);

	const flume = await benchFlume();
	process.stdout.write(
		`Flume (Redis Streams): ${flume.elapsed.toFixed(0)}ms  ` +
			`avg ${rate(MESSAGE_COUNT, flume.elapsed)}  peak ${Math.round(flume.peak).toLocaleString()} msg/s\n`,
	);

	const bull = await benchBullMQ();
	process.stdout.write(
		`BullMQ (baseline):     ${bull.elapsed.toFixed(0)}ms  ` +
			`avg ${rate(MESSAGE_COUNT, bull.elapsed)}  peak ${Math.round(bull.peak).toLocaleString()} msg/s\n`,
	);

	const ratio = bull.elapsed / flume.elapsed;
	process.stdout.write(
		`\nFlume is ${ratio.toFixed(2)}x ${ratio >= 1 ? "faster" : "slower"} than BullMQ on this run.\n`,
	);
}

main().then(
	() => process.exit(0),
	(error) => {
		process.stderr.write(`${error?.stack ?? error}\n`);
		process.exit(1);
	},
);
