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
	const client = createClient({ ...options, RESP: 2 }).withTypeMapping({
		[RESP_TYPES.BLOB_STRING]: Buffer,
	});

	// Drop this listener and a socket fault becomes an uncaught exception that kills the host process.
	client.on("error", () => {});

	return client;
}

// RESP 2: XINFO GROUPS has no RESP3 transform in node-redis v6.
export function createWriteClient(options: RedisClientOptions) {
	const client = createClient({ ...options, RESP: 2 });

	// Drop this listener and a socket fault becomes an uncaught exception that kills the host process.
	client.on("error", () => {});

	return client;
}
