import { hostname } from "node:os";
import { RedisClientOptions } from "redis";

// Reclaim mechanics live in the adapter (the core owns only retry *policy*).
export interface ReclaimOptions {
	// How often the reclaim loop runs (ms).
	readonly interval: number;
	// A message must be idle at least this long before reclaim steals it. MUST be
	// set safely above the max expected handler duration: reclaiming an in-flight
	// (slow-but-healthy) message bumps its delivery count and could wrongly
	// dead-letter work that never failed (PRD §8).
	readonly minIdleTime: number;
	// Max messages to claim per stream per reclaim pass (XAUTOCLAIM COUNT).
	readonly count: number;
	// The second slow-consumer mitigation: only reclaim when this instance's local
	// throughput is below this rate (events/sec). A saturated consumer leaves
	// pending messages for idler siblings instead of stealing in-flight work.
	readonly throughputThreshold: number;
}

// What a caller may pass: connection options plus optional overrides.
export interface RedisStreamsBrokerOptions {
	readonly redis: RedisClientOptions;
	// Unique per process so reclaim can tell this instance's pending entries from a
	// crashed instance's. Default: `{host}:{pid}` (PRD §9).
	readonly consumerName?: string;
	// XREADGROUP BLOCK timeout (ms) — how long a fresh read blocks before looping.
	readonly readTimeout?: number;
	// XREADGROUP COUNT — max messages pulled per blocking read.
	readonly readCount?: number;
	readonly reclaim?: Partial<ReclaimOptions>;
}

// The fully-resolved shape the broker runs on: every default applied once, so the
// broker body never reasons about `undefined`.
export interface ResolvedOptions {
	readonly redis: RedisClientOptions;
	readonly consumerName: string;
	readonly readTimeout: number;
	readonly readCount: number;
	readonly reclaim: ReclaimOptions;
}

const DEFAULT_READ_TIMEOUT = 5000;
const DEFAULT_READ_COUNT = 10;
const DEFAULT_RECLAIM: ReclaimOptions = {
	interval: 5000,
	minIdleTime: 30000,
	count: 100,
	throughputThreshold: 1000,
};

export function resolveOptions(
	options: RedisStreamsBrokerOptions,
): ResolvedOptions {
	return {
		redis: options.redis,
		consumerName: options.consumerName ?? `${hostname()}:${process.pid}`,
		readTimeout: options.readTimeout ?? DEFAULT_READ_TIMEOUT,
		readCount: options.readCount ?? DEFAULT_READ_COUNT,
		reclaim: { ...DEFAULT_RECLAIM, ...options.reclaim },
	};
}
