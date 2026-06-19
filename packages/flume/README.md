# @joaofnds/flume

Durable, at-least-once event dispatch and processing over a pluggable broker.

The surface is an event emitter — `emit(topic, payload)` / `on(topic, name, handler)` —
but everything behind it is real infrastructure: events are persisted, delivered
at-least-once, retried per-handler, dead-lettered when retries run out, and survive
process restarts and multiple machines.

```ts
const flume = new Flume({ namespace: "billing", broker, codec, clock, probe });

flume.on("order.placed", "charge-card", chargeCard);
flume.on("order.placed", "send-receipt", sendReceipt);

await flume.start();
await flume.emit("order.placed", { orderId: "ord_123", cents: 4200 });
```

`charge-card` and `send-receipt` each get their own durable cursor. If `charge-card`
throws, it retries on its own schedule; `send-receipt` is untouched.

## Why

Flume is bee's per-handler durable processing model, lifted off BullMQ and put behind
a broker port. The motivation is concrete: BullMQ moves jobs between states with
**server-side Lua scripts**, and Redis runs Lua on its single command thread, blocking
the whole server for the script's duration. Under load that serializes every other
client; on managed Redis, `EVAL` is often throttled, priced per-command, or constrained
in cluster mode. That bottleneck has forced a provider switch in production.

The Redis Streams adapter uses only plain commands — `XADD`, `XREADGROUP`, `XACK`,
`XAUTOCLAIM` — and **never `EVAL`**. Measured against a BullMQ baseline it runs at
**~1.0 commands/msg and 0.00 Lua/msg**, versus BullMQ's ~32–37 commands/msg and ~2
`EVAL`/msg. The no-scripting / portability win is the point; the throughput win
(≈1.4–7× on every variant) is the supporting act.

The price Streams charge: no native delayed delivery, so retry timing is reclaim-driven
and coarse rather than scheduled to the millisecond.

## Install

Published to GitHub Packages under the `@joaofnds` scope.

```
pnpm add @joaofnds/flume
```

The core (`@joaofnds/flume`) has **zero runtime dependencies**. The Redis adapter
(`@joaofnds/flume/redis`) needs two optional peers, pulled in only when you import it:

```
pnpm add redis @joaofnds/throughput
```

## Entry points

| Import | Contents |
| --- | --- |
| `@joaofnds/flume` | core — `Flume`, `Dispatcher`, `Worker`, domain types, `JsonCodec`, `SystemClock`, `LoggingProbe` |
| `@joaofnds/flume/redis` | `RedisStreamsBroker` and its options/errors |
| `@joaofnds/flume/testing` | `FakeBroker`, `FakeClock`, `FakeProbe` for unit tests with no Redis |

The split is physical: the core never imports an adapter, so a core-only consumer
installs neither `redis` nor `@joaofnds/throughput`.

## Quick start (Redis)

```ts
import { Flume, JsonCodec, SystemClock, LoggingProbe } from "@joaofnds/flume";
import { RedisStreamsBroker } from "@joaofnds/flume/redis";

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

## Concepts

**Event handler.** Anything with `handle(event): Promise<void>`. The handler is the
durable unit. `event.payload` is your decoded value; `event.id`, `event.deliveryCount`,
and `event.dispatchedAt` carry delivery metadata.

```ts
import { Event, EventHandler } from "@joaofnds/flume";

class ChargeCard implements EventHandler<{ orderId: string; cents: number }> {
  async handle(event: Event<{ orderId: string; cents: number }>) {
    await this.payments.charge(event.payload.orderId, event.payload.cents);
  }
}
```

**Per-handler durability.** Each `on(topic, name, …)` is an independent subscription
with its own consumer group and cursor. A failing handler retries without blocking its
siblings on the same topic. Names are scoped by the `Flume` namespace, so the same
handler name in two services never collides.

**Retry and dead-letter.** A `RetryPolicy` caps attempts (default 5). A handler that
throws is nacked and redelivered; once `deliveryCount` exceeds `maxAttempts`, the
message is written to a dead-letter stream (`{topic}:dead:{namespace}:{name}`) and
acked. You get exactly `maxAttempts` handler invocations.

```ts
import { RetryPolicy } from "@joaofnds/flume";

flume.on("order.placed", "charge-card", handler, {
  retry: new RetryPolicy({ maxAttempts: 3 }),
});
```

**Delivery mode.** `Competing` (default) load-balances a subscription across instances —
one of them handles each event. `Broadcast` gives every instance its own group, so all
of them see every event.

```ts
import { DeliveryMode } from "@joaofnds/flume";

flume.on("config.changed", "reload-cache", handler, {
  delivery: DeliveryMode.Broadcast,
});
```

**Start position.** `startFrom: "new"` (default) reads only events dispatched after the
subscription is created; `"beginning"` replays the whole stream.

## Configuration

Pluggable seams, all injected into `Flume`:

- **`Codec`** — how payloads are serialized. `JsonCodec` ships in core. The wire format
  is a binary envelope framing arbitrary bytes verbatim, so a msgpack/protobuf codec
  round-trips non-UTF-8 payloads untouched.
- **`Clock`** — `SystemClock` in production, `FakeClock` in tests. `dispatchedAt` is
  stamped from the clock, never global time.
- **`Probe`** — observability hook called on dispatch / process / failure / dead-letter.
  `LoggingProbe` emits one structured JSON line per event (override `ProbeLogger` to
  route it elsewhere); `FakeProbe` is a no-op for tests. A throwing probe can never make
  `emit` reject or block an ack.

### Redis adapter options

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

The Redis adapter can replay a dead-letter stream back onto its live topic. It is
idempotent on the original message id, so re-running after a crash re-drives rather than
drops.

```ts
const result = await broker.redriveDeadLetters({
  topic: new Topic("order.placed"),
  name: "billing:charge-card", // full namespace-folded subscription name
});
// { redriven: 4, skipped: 1 }
```

## Producer / consumer split

`Flume` bundles a producer and a consumer for convenience. To run them as separate
tiers — an API that only emits, a worker pool that only processes — use `Dispatcher`
(publish only) and `Worker` (consume + publish for dead-letter) directly. Both take
plain dependencies, so there is no DI framework in the way.

## Testing

Use `@joaofnds/flume/testing` to drive handlers with no Redis:

```ts
import { FakeBroker, FakeClock, FakeProbe } from "@joaofnds/flume/testing";

const broker = new FakeBroker();
const flume = new Flume({
  namespace: "test",
  broker,
  codec: new JsonCodec(),
  clock: new FakeClock(),
  probe: new FakeProbe(),
});
```

`FakeBroker` exposes two distinct drivers — `deliverFresh` (forces delivery count 1) and
`redeliver` (forces count > 1) — because delivery count is authoritative only on the
reclaim path. A fresh delivery is always attempt 1; the count is real only when a redelivery
supplies it. The fake matches what the Redis adapter can actually honor.

## License

MIT
