import { hostname } from "node:os";
import { RedisClientOptions } from "redis";

export class InvalidBroadcastOptionsError extends Error {
	constructor(heartbeatInterval: number, heartbeatTtl: number) {
		super(
			`broadcast heartbeatTtl (${heartbeatTtl}ms) must be greater than heartbeatInterval (${heartbeatInterval}ms)`,
		);
		this.name = "InvalidBroadcastOptionsError";
	}
}

export interface ReclaimOptions {
	readonly interval: number;
	readonly minIdleTime: number;
	readonly count: number;
	readonly throughputThreshold: number;
}

export interface BroadcastOptions {
	readonly heartbeatInterval: number;
	readonly heartbeatTtl: number;
}

export interface ReaperOptions {
	readonly interval: number;
	readonly trim: boolean;
}

export interface RedisStreamsBrokerOptions {
	readonly redis: RedisClientOptions;
	readonly consumerName?: string;
	readonly instanceId?: string;
	readonly readTimeout?: number;
	readonly readCount?: number;
	readonly reclaim?: Partial<ReclaimOptions>;
	readonly broadcast?: Partial<BroadcastOptions>;
	readonly reaper?: Partial<ReaperOptions>;
}

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
