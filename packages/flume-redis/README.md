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
  readCount: 10,                    // batch size / in-flight concurrency per read
  reclaim: { minIdleTime: 30000, count: 100, throughputThreshold: 1000 },
  broadcast: { heartbeatInterval: 10000, heartbeatTtl: 30000 },
  reaper: { interval: 30000, trim: false },
});
```

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

MIT
