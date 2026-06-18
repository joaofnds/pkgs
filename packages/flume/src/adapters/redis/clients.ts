import {
	createClient,
	RESP_TYPES,
	RedisClientOptions,
	RedisClientType,
	RedisFunctions,
	RedisModules,
	RedisScripts,
} from "redis";

// A binary-clean client: blob replies (`$`) decode to Buffer, not string. Without
// this, node-redis returns strings for blob replies and silently UTF-8-mangles a
// non-UTF-8 (msgpack/protobuf) payload — the exact feature Flume advertises. We
// also pin RESP 2 on these clients for a deterministic, well-trodden decode path
// (PRD §8 "Binary reads"). The field-name keys stay ASCII (Buffer#toString in the
// reply transform), so lookups like `message["payload"]` are unaffected.
//
// The generics mirror what `createClient({ RESP: 2 }).withTypeMapping(...)` infers
// (no modules/functions/scripts); the annotation is required because the proxy
// type withTypeMapping returns cannot be named in the emitted declarations.
export type ReadClient = RedisClientType<
	RedisModules,
	RedisFunctions,
	RedisScripts,
	2,
	{ [RESP_TYPES.BLOB_STRING]: typeof Buffer }
>;
export type WriteClient = ReturnType<typeof createWriteClient>;

export function createReadClient(options: RedisClientOptions): ReadClient {
	return createClient({ ...options, RESP: 2 }).withTypeMapping({
		[RESP_TYPES.BLOB_STRING]: Buffer,
	});
}

// Write + control-plane client: XADD/XACK/XGROUP, plus the M3 ops commands
// (XINFO GROUPS / XPENDING / XTRIM / XGROUP DESTROY and the broadcast-liveness
// SET/SADD/SMEMBERS/SREM/EXISTS). It carries no binary *payload* in its replies,
// so it needs no blob→Buffer mapping — and pinning RESP 2 keeps replies as plain
// strings/numbers. That matters for XINFO GROUPS especially: node-redis v6
// defaults to RESP3, but its XINFO GROUPS RESP3 transform is `undefined`, so the
// command only works under RESP 2. Stream ids (last-delivered-id, XPENDING ids)
// come back as the `<ms>-<seq>` strings the reaper compares.
export function createWriteClient(options: RedisClientOptions) {
	return createClient({ ...options, RESP: 2 });
}
