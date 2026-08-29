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

interface ErrorEmitter {
	on(event: "error", listener: () => void): unknown;
}

// Without this listener a socket fault becomes an uncaught exception that kills the host process.
function ignoreSocketErrors(client: ErrorEmitter): void {
	client.on("error", () => {});
}

// Pins RESP 2 and maps blob→Buffer for binary-clean reads; node-redis's XINFO GROUPS has no RESP3 transform.
export function createReadClient(options: RedisClientOptions): ReadClient {
	const client = createClient({ ...options, RESP: 2 }).withTypeMapping({
		[RESP_TYPES.BLOB_STRING]: Buffer,
	});
	ignoreSocketErrors(client);

	return client;
}

// RESP 2: XINFO GROUPS has no RESP3 transform in node-redis v6.
export function createWriteClient(options: RedisClientOptions) {
	const client = createClient({ ...options, RESP: 2 });
	ignoreSocketErrors(client);

	return client;
}
