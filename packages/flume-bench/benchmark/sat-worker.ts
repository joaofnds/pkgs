// One saturation load unit, run on its own thread. role:"producer" publishes as
// fast as a bounded in-flight window allows (pausable, so the orchestrator can
// cap the unconsumed backlog); role:"consumer" acks every delivery. Both stream
// published/processed counts back every 250ms; the orchestrator derives steady-
// state throughput from the deltas. No top-level await — tsx transforms these to
// CJS, which forbids it.

import { parentPort, workerData } from "node:worker_threads";
import {
	type Broker,
	DeliveryMode,
	RetryPolicy,
	type RunningConsumer,
	Subscription,
	Topic,
} from "@joaofnds/flume";
import { NatsStreamsBroker } from "@joaofnds/flume-nats";
import { RedisStreamsBroker } from "@joaofnds/flume-redis";
import type { MainToWorker, WorkerConfig, WorkerToMain } from "./sat-types";

type ManagedBroker = Broker & {
	connect(): Promise<void>;
	close(): Promise<void>;
};

const HOUR = 3_600_000;
const cfg = workerData as WorkerConfig;
const port = parentPort;
if (port === null) throw new Error("sat-worker must run as a worker thread");

const now = (): number => performance.timeOrigin + performance.now();
const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

let published = 0;
let processed = 0;
let paused = false;
const stop = Promise.withResolvers<void>();
let stopped = false;

port.on("message", (msg: MainToWorker) => {
	if (msg.type === "pause") paused = true;
	else if (msg.type === "resume") paused = false;
	else if (msg.type === "stop") {
		stopped = true;
		stop.resolve();
	}
});

function post(msg: WorkerToMain): void {
	port?.postMessage(msg);
}

function makeBroker(): ManagedBroker {
	if (cfg.system === "nats") {
		return new NatsStreamsBroker({
			nats: { servers: cfg.url },
			readCount: cfg.readCount,
			ackWait: HOUR,
		});
	}
	return new RedisStreamsBroker({
		redis: { url: cfg.url },
		readTimeout: 50,
		readCount: cfg.readCount,
		consumerName: cfg.consumerName,
		reclaim: {
			interval: HOUR,
			minIdleTime: HOUR,
			count: 200,
			throughputThreshold: 1e9,
		},
		broadcast: { heartbeatInterval: HOUR, heartbeatTtl: 2 * HOUR },
		reaper: { interval: HOUR, trim: false },
	});
}

function subscription(): Subscription {
	return new Subscription({
		topic: new Topic(cfg.topic),
		name: cfg.subName,
		handler: { async handle() {} },
		retry: new RetryPolicy({ maxAttempts: 1 }),
		delivery: DeliveryMode.Competing,
		startFrom: "new",
	});
}

async function pump(broker: Broker): Promise<void> {
	const topic = new Topic(cfg.topic);
	const body = Buffer.alloc(Math.max(cfg.payload, 8), 1);
	const inflight = new Set<Promise<void>>();
	while (!stopped) {
		if (paused) {
			await sleep(2);
			continue;
		}
		while (inflight.size < cfg.pubInflight && !paused && !stopped) {
			const task = broker
				.publish(topic, body)
				.then(() => {
					published += 1;
				})
				.catch(() => {})
				.finally(() => inflight.delete(task));
			inflight.add(task);
		}
		if (inflight.size > 0) await Promise.race(inflight);
		else await sleep(1);
	}
	await Promise.allSettled(inflight);
}

async function main(): Promise<void> {
	const broker = makeBroker();
	await broker.connect();
	const ticker = setInterval(
		() => post({ type: "stat", published, processed, t: now() }),
		250,
	);

	let running: RunningConsumer | undefined;
	if (cfg.role === "consumer") {
		running = await broker.consume(subscription(), async (msg) => {
			await msg.ack();
			processed += 1;
		});
		post({ type: "ready" });
		await stop.promise;
	} else {
		post({ type: "ready" });
		await pump(broker);
	}

	clearInterval(ticker);
	post({ type: "stat", published, processed, t: now() });
	if (running !== undefined) await running.stop();
	await broker.close();
	post({ type: "stopped" });
}

main().catch((error) =>
	post({ type: "error", message: String((error as Error)?.message ?? error) }),
);
