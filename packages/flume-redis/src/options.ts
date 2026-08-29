import { hostname } from "node:os";
import { RedisClientOptions } from "redis";
import { InvalidCountError } from "./invalid-count-error";
import { InvalidIdleTimeError } from "./invalid-idle-time-error";
import { InvalidIntervalError } from "./invalid-interval-error";
import { InvalidRateError } from "./invalid-rate-error";
import { InvalidTimeoutError } from "./invalid-timeout-error";

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
	const readTimeout = options.readTimeout ?? DEFAULT_READ_TIMEOUT;
	const readCount = options.readCount ?? DEFAULT_READ_COUNT;
	const reclaim = { ...DEFAULT_RECLAIM, ...options.reclaim };
	const broadcast = { ...DEFAULT_BROADCAST, ...options.broadcast };
	const reaper = { ...DEFAULT_REAPER, ...options.reaper };

	requireTimeout("readTimeout", readTimeout);
	requireCount("readCount", readCount);
	requireInterval("reclaim.interval", reclaim.interval);
	requireIdleTime("reclaim.minIdleTime", reclaim.minIdleTime);
	requireRate("reclaim.throughputThreshold", reclaim.throughputThreshold);
	requireInterval("reaper.interval", reaper.interval);
	requireInterval("broadcast.heartbeatInterval", broadcast.heartbeatInterval);
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
		readTimeout,
		readCount,
		reclaim,
		broadcast,
		reaper,
	};
}

function requireInterval(option: string, value: number): void {
	if (Number.isSafeInteger(value) && value >= 1) return;

	throw new InvalidIntervalError(option, value);
}

function requireTimeout(option: string, value: number): void {
	if (Number.isSafeInteger(value) && value >= 1) return;

	throw new InvalidTimeoutError(option, value);
}

function requireIdleTime(option: string, value: number): void {
	if (Number.isSafeInteger(value) && value >= 0) return;

	throw new InvalidIdleTimeError(option, value);
}

function requireRate(option: string, value: number): void {
	if (Number.isFinite(value) && value >= 0) return;

	throw new InvalidRateError(option, value);
}

function requireCount(option: string, value: number): void {
	if (Number.isSafeInteger(value) && value >= 1) return;

	throw new InvalidCountError(option, value);
}
