import { hostname } from "node:os";
import { RedisClientOptions } from "redis";

// A broadcast group is kept alive by refreshing a TTL key every heartbeatInterval;
// the reaper destroys a group whose key expired. If the TTL is not strictly above
// the interval, a live instance's key can lapse between two refreshes and the
// reaper destroys a group that is still in use — silently breaking at-least-once
// for broadcast. Fail fast on the misconfiguration rather than ship the footgun.
export class InvalidBroadcastOptionsError extends Error {
	constructor(heartbeatInterval: number, heartbeatTtl: number) {
		super(
			`broadcast heartbeatTtl (${heartbeatTtl}ms) must be greater than heartbeatInterval (${heartbeatInterval}ms)`,
		);
		this.name = "InvalidBroadcastOptionsError";
	}
}

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

// Broadcast (per-instance group) liveness. Each broadcast group an instance owns
// is kept alive by refreshing a TTL key; the reaper destroys a group whose key
// expired (PRD §8 "Broadcast group lifecycle"). The TTL MUST be comfortably above
// the heartbeat interval so a momentary pause does not make a live instance look
// dead and get its group reaped out from under it.
export interface BroadcastOptions {
	readonly heartbeatInterval: number;
	readonly heartbeatTtl: number;
}

// The reaper runs periodically to (1) XGROUP DESTROY expired broadcast groups and
// (2) optionally trim live topic streams by XTRIM MINID. Trimming is OFF by
// default — live streams are never trimmed unless asked (PRD §8: never naive
// MAXLEN; MINID over the min low-water-mark across live groups is the sanctioned,
// opt-in reaper).
export interface ReaperOptions {
	readonly interval: number;
	readonly trim: boolean;
}

// What a caller may pass: connection options plus optional overrides.
export interface RedisStreamsBrokerOptions {
	readonly redis: RedisClientOptions;
	// Unique per process so reclaim can tell this instance's pending entries from a
	// crashed instance's. Default: `{host}:{pid}` (PRD §9).
	readonly consumerName?: string;
	// Identifies THIS instance in a broadcast group id `flume:{sub.name}:{instanceId}`,
	// so every instance gets its own group and sees every message. Must be unique
	// per instance and stable for its lifetime. Default: `{host}:{pid}` (PRD §9).
	readonly instanceId?: string;
	// XREADGROUP BLOCK timeout (ms) — how long a fresh read blocks before looping.
	readonly readTimeout?: number;
	// XREADGROUP COUNT — max messages pulled per blocking read.
	readonly readCount?: number;
	readonly reclaim?: Partial<ReclaimOptions>;
	readonly broadcast?: Partial<BroadcastOptions>;
	readonly reaper?: Partial<ReaperOptions>;
}

// The fully-resolved shape the broker runs on: every default applied once, so the
// broker body never reasons about `undefined`.
export interface ResolvedOptions {
	readonly redis: RedisClientOptions;
	readonly consumerName: string;
	readonly instanceId: string;
	readonly readTimeout: number;
	readonly readCount: number;
	readonly reclaim: ReclaimOptions;
	readonly broadcast: BroadcastOptions;
	readonly reaper: ReaperOptions;
}

const DEFAULT_READ_TIMEOUT = 5000;
const DEFAULT_READ_COUNT = 10;
const DEFAULT_RECLAIM: ReclaimOptions = {
	interval: 5000,
	minIdleTime: 30000,
	count: 100,
	throughputThreshold: 1000,
};
const DEFAULT_BROADCAST: BroadcastOptions = {
	heartbeatInterval: 10000,
	heartbeatTtl: 30000,
};
const DEFAULT_REAPER: ReaperOptions = {
	interval: 30000,
	trim: false,
};

export function resolveOptions(
	options: RedisStreamsBrokerOptions,
): ResolvedOptions {
	const defaultId = `${hostname()}:${process.pid}`;
	const broadcast = { ...DEFAULT_BROADCAST, ...options.broadcast };
	if (broadcast.heartbeatTtl <= broadcast.heartbeatInterval) {
		throw new InvalidBroadcastOptionsError(
			broadcast.heartbeatInterval,
			broadcast.heartbeatTtl,
		);
	}
	return {
		redis: options.redis,
		consumerName: options.consumerName ?? defaultId,
		instanceId: options.instanceId ?? defaultId,
		readTimeout: options.readTimeout ?? DEFAULT_READ_TIMEOUT,
		readCount: options.readCount ?? DEFAULT_READ_COUNT,
		reclaim: { ...DEFAULT_RECLAIM, ...options.reclaim },
		broadcast,
		reaper: { ...DEFAULT_REAPER, ...options.reaper },
	};
}
