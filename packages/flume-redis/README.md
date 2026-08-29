# @joaofnds/flume-redis

Redis Streams broker adapter for [`@joaofnds/flume`](../flume) — durable,
at-least-once event processing backed by Redis Streams, using **only plain
commands** (`XADD`, `XREADGROUP`, `XACK`, `XAUTOCLAIM`) and **never `EVAL`/Lua**.

```ts
import { Flume, JsonCodec, SystemClock, LoggingProbe } from "@joaofnds/flume";
import { RedisStreamsBroker } from "@joaofnds/flume-redis";

const broker = new RedisStreamsBroker({ redis: { url: "redis://localhost:6379" } });
await broker.connect();

const flume = new Flume({
  namespace: "billing",
  broker,
  codec: new JsonCodec(),
  clock: new SystemClock(),
  probe: new LoggingProbe(),
});

flume.on("order.placed", "charge-card", {
  async handle(event) {
    await chargeCard(event.payload);
  },
});

await flume.start();
await flume.emit("order.placed", { orderId: "ord_123", cents: 4200 });

// on shutdown
await flume.stop();
await broker.close();
```

`Flume` does not own the broker connection — construct and `connect()` the broker
yourself, then hand it in. That keeps the lifecycle explicit and lets a producer and a
consumer share construction code while connecting independently.

## Why a plain-command adapter

BullMQ moves jobs between states with **server-side Lua scripts**, and Redis runs Lua on
its single command thread, blocking the whole server for the script's duration. Under
load that serializes every other client; on managed Redis, `EVAL` is often throttled,
priced per-command, or constrained in cluster mode.

This adapter never scripts. Measured against a BullMQ baseline it runs at **~1.0
commands/msg and 0.00 Lua/msg**, versus BullMQ's ~32–37 commands/msg and ~2 `EVAL`/msg.
The no-scripting / portability win is the point; the throughput win (≈1.4–7× on every
variant) is the supporting act.

The price Streams charge: no native delayed delivery, so retry timing is reclaim-driven
and coarse rather than scheduled to the millisecond.

## Install

Published to GitHub Packages under the `@joaofnds` scope.

```
pnpm add @joaofnds/flume @joaofnds/flume-redis redis
```

`redis` is a peer dependency — bring your own client version. `@joaofnds/flume` (the
core) and `@joaofnds/throughput` (the reclaim throughput gate) are pulled in
automatically.

## Options

```ts
new RedisStreamsBroker({
  redis: { url: "redis://localhost:6379" },
  consumerName: "billing-worker-1", // identity within a competing group (default {host}:{pid})
  instanceId: "billing-worker-1",   // identity of a broadcast group     (default {host}:{pid})
  readTimeout: 5000,                // integer >= 1: the XREADGROUP BLOCK, in ms
  readCount: 10,                    // integer >= 1: batch size, claim page size, in-flight concurrency
  reclaim: {
    interval: 5000,                 // integer >= 1: floor between one consumer's reclaim turns, in ms
    minIdleTime: 30000,             // integer >= 0: how long a message sits unacked before a peer may claim it
    throughputThreshold: 1000,      // finite >= 0: claim only while THIS consumer's throughput is below this, in msg/s
  },
  broadcast: { heartbeatInterval: 10000, heartbeatTtl: 30000 },
  reaper: { interval: 30000, trim: false },
});
```

`reclaim.throughputThreshold` is **per-consumer**: the gate compares it against the
throughput of the consumer whose group is about to be claimed from, so one busy
subscription can no longer hold another subscription's recovery shut. (It was broker-wide
before; the name, the type and the default of 1000 are unchanged, and at any given value
the gate is never less permissive than it was, and strictly more so for any consumer whose
peers took traffic in the window.) Of the two slow-consumer mitigations,
**`minIdleTime` above your max handler duration is the one of record** — set it
deliberately. The throughput gate is a secondary proxy for a peer process sitting
mid-handler, and no in-process number can observe that directly.

Every numeric option is parsed at construction, so a value outside its domain throws
instead of degrading somewhere deep in the adapter. The errors are exported and carry the
option name and the value: `InvalidTimeoutError`, `InvalidCountError`,
`InvalidIntervalError`, `InvalidIdleTimeError`, `InvalidRateError`, and
`InvalidBroadcastOptionsError`. `readTimeout: 0` is the one worth calling out: `BLOCK 0`
waits forever, and no client-side timeout in `@redis/client` 6.x will cut it short.

In containerized fleets where pids collide (pid 1 per container) or hostnames are
shared, **override both `consumerName` and `instanceId`** — otherwise broadcast
degrades to competing and reclaim may steal a peer's in-flight work.

`reaper.trim` is opt-in and off by default: live streams are never length-trimmed, since
that would drop entries a slow group still needs.

## Dead-letter redrive

The adapter can replay a dead-letter stream back onto its live topic. It is idempotent on
the original message id, so re-running after a crash re-drives rather than drops.

```ts
import { Topic } from "@joaofnds/flume";

const result = await broker.redriveDeadLetters({
  topic: new Topic("order.placed"),
  name: "billing:charge-card", // full namespace-folded subscription name
});
// { redriven: 4, skipped: 1 }
```

## License

Apache-2.0. See [LICENSE](LICENSE).
