import {
	createClient,
	RESP_TYPES,
	RedisClientOptions,
	RedisClientType,
	RedisFunctions,
	RedisModules,
	RedisScripts,
} from "redis";

export type ReadClient = RedisClientType<
	RedisModules,
	RedisFunctions,
	RedisScripts,
	2,
	{ [RESP_TYPES.BLOB_STRING]: typeof Buffer }
>;
export type WriteClient = ReturnType<typeof createWriteClient>;

// Pins RESP 2 and maps blob→Buffer for binary-clean reads; node-redis's XINFO GROUPS has no RESP3 transform.
export function createReadClient(options: RedisClientOptions): ReadClient {
	return createClient({ ...options, RESP: 2 }).withTypeMapping({
		[RESP_TYPES.BLOB_STRING]: Buffer,
	});
}

const BLOCKING_TIMEOUT_MARGIN_MS = 1000;

export function blockingCommandTimeout(blockMs: number): number {
	return blockMs + BLOCKING_TIMEOUT_MARGIN_MS;
}

export function createBlockingReadClient(
	options: RedisClientOptions,
	blockMs: number,
): ReadClient {
	return createClient({
		...options,
		RESP: 2,
		commandOptions: { timeout: blockingCommandTimeout(blockMs) },
	}).withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer });
}

// RESP 2: XINFO GROUPS has no RESP3 transform in node-redis v6.
export function createWriteClient(options: RedisClientOptions) {
	return createClient({ ...options, RESP: 2 });
}
