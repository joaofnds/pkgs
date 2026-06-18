# PRD — @joaofnds/flume

> Durable, at-least-once event dispatch and processing over a pluggable broker.
> bee's per-handler durable semantics, expressed through a hexagonal core, with
> Redis Streams as the first concrete broker (NATS / Kafka / RabbitMQ later).

Status: **draft** · Owner: joaofnds · Scope of this doc: the framework-agnostic
**core** + the **Redis Streams** adapter. NestJS integration is explicitly out of
scope for v1 and arrives later as a driving adapter.

---

## 1. Background & motivation

Two existing packages bracket the problem:

- **`@joaofnds/bee`** gives the developer ergonomics we want: a handler is a
  durable unit, **each handler retries independently** of its siblings (one
  failing listener never blocks the others), retry/backoff is configurable, and
  producer and consumer tiers can run as **separate processes** against shared
  infrastructure. But it is welded to BullMQ (Redis-specific) *and* NestJS.
- **`@joaofnds/streams-connector`** already proves out the Redis Streams
  mechanics we need — consumer groups, blocking `XREADGROUP`, `XAUTOCLAIM`
  reclaim of stalled messages, dead-lettering on max-deliveries, idempotent
  group creation, separate read/write/reclaim clients. But its model is "mirror
  `EventEmitter2` across processes", not "durable, independently-retried
  per-handler work".

**Flume is the synthesis:** bee's per-handler durable processing model, lifted
off BullMQ and behind a **broker port**, so the same handler code runs over
Redis Streams today and NATS/Kafka/RabbitMQ tomorrow without changing the
domain. The core is framework-agnostic; NestJS, like every transport, is an
adapter.

The shape app code sees is an **event emitter** — `emit(topic, payload)` /
`on(topic, handler)` — but every classic event-system guarantee (durability,
at-least-once, retry, dead-letter, survives restarts, multi-machine) is provided
behind it. Familiar surface, real infrastructure underneath.

**Why drop BullMQ specifically — the core motivation.** BullMQ leans heavily on
**server-side Lua scripts** to move jobs between states atomically. Redis runs
Lua on its single command thread and **blocks the entire server for the script's
duration**, so under load Bull's scripting serializes every other client; and on
many **managed Redis providers** `EVAL` is throttled, priced per-command, or
constrained in cluster mode (every key a script touches must hash to one slot).
This is not theoretical — it has forced a Redis-provider switch in production.
**That bottleneck is the primary reason Flume exists.**

Redis Streams sidestep it entirely: `XADD` / `XREADGROUP` / `XACK` /
`XAUTOCLAIM` are **plain native commands** every provider supports and prices
normally — **no `EVAL`**. They're also leaner per message (append-only log,
batched reads, native consumer-group + pending-entry tracking) than Bull's
multi-structure job lifecycle. The price we accept: **no native delayed
delivery**, so retry/backoff timing is reclaim-idle-driven and coarse (§8). Raw
throughput is still validated with a **benchmark vs a BullMQ baseline** (M2,
§14) — but the no-scripting / portability win is the load-bearing motivation,
independent of the throughput numbers.

A flume is a channel that carries flowing water — the name fits an event
pipeline.

---

## 2. Goals / non-goals

### Goals (v1)

1. A **framework-agnostic, dependency-free core** that models dispatching and
   processing events, with all I/O behind ports.
2. **Per-handler retry isolation** — each handler is its own durable unit; one
   handler's failure, retries, and dead-lettering are independent of siblings.
3. A **Redis Streams broker adapter** (TCP Redis) implementing the broker port,
   **isolated behind its own entry point** so it can later be extracted into a
   standalone `@joaofnds/flume-redis` package (and `flume-nats`, etc.) without
   touching the core — see §13.
4. **Horizontal scale-out by default** (competing consumers across instances),
   with **broadcast** as an opt-in per subscription.
5. **At-least-once delivery** with a configurable retry policy and dead-lettering
   on exhaustion.
6. **An `EventEmitter`-like public surface over a classic-OOP core.** App code
   uses a familiar emit / subscribe facade; the internals are hexagonal —
   handlers are classes implementing a role interface, subscriptions are explicit
   value objects, construction is DI-friendly, no global import-side-effect
   registry. Two necessary departures from `EventEmitter`: `emit` is **async**
   (it crosses the network), and durable subscribers need a **stable name** (it
   becomes the consumer group) — see §5.
7. A **fast unit-test path** for the core (in-memory `FakeBroker` + `FakeClock`),
   plus **integration tests** for the Redis adapter against real Redis.
8. **No server-side scripting.** The Redis adapter uses only plain Stream
   commands — **never `EVAL`/Lua** — so it stays fast under load and portable
   across managed Redis providers. This is the motivating constraint (§1), not an
   afterthought.

### Non-goals (v1 — revisit later)

- **NestJS adapter** — designed for, not built yet.
- **NATS / Kafka / RabbitMQ adapters** — the port is shaped to accept them; only
  Redis Streams ships in v1.
- **Exactly-once delivery** — at-least-once only. Handlers must be idempotent.
- **Precise scheduled / delayed delivery** — Redis Streams has no native delay;
  retry timing in v1 is reclaim-driven (coarse), not arbitrary backoff curves.
- **Strict cross-message ordering** — competing consumers process concurrently;
  no global ordering guarantee (same as bee/BullMQ).
- **Schema validation inside the core** — the core is payload-agnostic. A typed
  (Zod) layer is optional and sits *on top* of the core, never inside it.

---

## 3. Ubiquitous language (DDD glossary)

| Term            | Meaning |
|-----------------|---------|
| **Event**       | A domain occurrence: a `Topic` + a payload + minimal metadata. |
| **Topic**       | The named channel an event flows on (e.g. `user.created`). Value object. |
| **Message**     | An event encoded for the wire: an envelope around serialized bytes. |
| **Handler**     | A class that processes events for a topic. The durable unit. Plays the `EventHandler` role. |
| **Subscription**| The binding of `{ topic, handler, name, retry policy, delivery mode }`. Its `name` is the durable identity → the consumer group. |
| **Dispatch**    | Publishing an event so subscribers can process it durably (bee: emit → enqueue). |
| **Process**     | A subscriber consuming an event: invoke handler → ack on success → leave for redelivery on failure → dead-letter on exhaustion. |
| **Broker**      | The driven port abstracting the eventing backend (Redis Streams, NATS, …). Composed of `Publisher` + `Consumer` roles. |
| **Codec**       | The serialization port. JSON by default. |
| **DeadLetter**  | Destination for messages whose handler exhausted its retry policy. |
| **Probe**       | The observability port — declares business-relevant events (dispatched, processed, failed, dead-lettered). No-op in tests. |

---

## 4. Architecture (hexagonal / ports & adapters)

Dependencies point inward. The core depends on nothing; adapters depend on the
core's ports.

```
        ┌──────────────────────────────────────────────┐
        │                  Driving side                  │
        │     app code · (later) NestJS adapter · CLI     │
        └───────────────┬────────────────┬───────────────┘
            dispatch(…)  │                │  register(sub) + start()
                         ▼                ▼
        ┌──────────────────────────────────────────────┐
        │                   Flume core                   │
        │  Dispatcher · Worker · Subscription            │
        │  Event · Topic · RetryPolicy · DeliveryMode    │
        │                                                │
        │  driven ports:                                 │
        │   Publisher · Consumer · Codec · Clock · Probe │
        └───────────────┬────────────────┬───────────────┘
              implements │                │ implements
                         ▼                ▼
        ┌──────────────────────────────────────────────┐
        │                 Driven adapters                │
        │  RedisStreamsBroker (v1) · JsonCodec ·         │
        │  SystemClock · (later) NATS / Kafka / Rabbit   │
        └──────────────────────────────────────────────┘
```

**Division of responsibility — the key decision.** Retry *policy* (count
attempts, decide when to dead-letter) is **domain logic and lives in the core**.
Retry *mechanics* (how redelivery actually happens — `XAUTOCLAIM` reclaim, idle
timeouts, group management, offset commits) live **in the adapter**. The broker
port is defined at the level of *"at-least-once delivery with explicit
acknowledgment, per-message delivery count, and redelivery"* — the common
denominator across the target brokers. This keeps the policy testable without
infrastructure and keeps each broker free to implement redelivery natively.

---

## 5. Domain model & ports

> Interface sketches below are **indicative, driven out by TDD** — not a frozen
> API. They exist to convey shape and the dependency direction.

### Core value objects & roles

```ts
class Topic {
  constructor(readonly name: string) {}
}

// Payload is `unknown` at the agnostic core. A concrete handler parses it at its
// own boundary (e.g. with Zod), or the optional typed layer parses for it.
class Event<T = unknown> {
  constructor(readonly props: {
    readonly topic: Topic;
    readonly payload: T;
    readonly id: string;          // broker-assigned message id
    readonly deliveryCount: number; // 1 on first delivery
    readonly dispatchedAt: Date;
  }) {}
}

// The durable-unit role. Concrete handlers are classes with injected deps.
interface EventHandler<T = unknown> {
  handle(event: Event<T>): Promise<void>;
}

class RetryPolicy {
  // v1 contract is attempt-count only. Retry *timing* is broker config
  // (Redis: reclaim minIdleTime/interval), NOT a per-policy promise — the broker
  // port has no delay primitive (§8), and a `nack` redelivers immediately on
  // brokers that lack idle-based reclaim. Precise backoff needs a scheduler:
  // deferred. Promising `backoff` here would be a contract the port can't keep.
  constructor(readonly props: { readonly maxAttempts: number }) {}
}

enum DeliveryMode { Competing, Broadcast }

// The binding. `name` is the durable identity → consumer group → MUST be stable
// across deploys AND unique per topic: two subs sharing {topic, name} would share
// one group and split work, silently breaking per-handler isolation (Worker
// rejects duplicates — see below). Renaming it orphans the old group's pending.
class Subscription {
  constructor(readonly props: {
    readonly topic: Topic;
    readonly name: string;
    readonly handler: EventHandler;
    readonly retry: RetryPolicy;
    readonly delivery: DeliveryMode;
    readonly startFrom?: "new" | "beginning"; // default "new" — see §8
  }) {}
}
```

### Driven ports

```ts
type Bytes = Uint8Array; // runtime-neutral; adapters convert at the edge (Redis: Buffer/string)

// Producer side. The API tier needs only this. `body` is the framed envelope
// bytes (versioned wire format, §6); the adapter treats it as opaque.
interface Publisher {
  publish(topic: Topic, body: Bytes): Promise<void>;
}

// Consumer side. The adapter delivers BOTH fresh reads and reclaimed
// redeliveries through this one callback; `deliveryCount` distinguishes them. The
// adapter owns all redelivery mechanics (reclaim, idle timeouts, group mgmt).
interface Consumer {
  consume(
    sub: Subscription,
    deliver: (msg: DeliveredMessage) => Promise<void>,
  ): Promise<RunningConsumer>;
}

interface DeliveredMessage {
  readonly topic: Topic;
  readonly id: string;
  readonly body: Bytes;
  // Attempt number for THIS delivery. `1` on a fresh delivery — set with NO extra
  // broker round-trip (Redis `XREADGROUP >` returns no count; a first read is
  // attempt 1 by definition). `> 1` only on a redelivery, where the broker
  // supplies the count (Redis: `XAUTOCLAIM`/`XPENDING`). So there is no
  // per-message `XPENDING` on the hot/fresh path; the count is authoritative only
  // on redelivery. Attempt-accounting rule: §7/§8.
  readonly deliveryCount: number;
  ack(): Promise<void>;  // processed OK — remove from the pending set (XACK)
  nack(): Promise<void>; // leave pending → reclaim loop redelivers it later
}

interface RunningConsumer { stop(): Promise<void>; }

// A broker is just both roles. Redis adapter implements both; the API tier may
// only construct the Publisher half, the worker tier only the Consumer half.
type Broker = Publisher & Consumer;

// Bytes are Uint8Array (binary-clean, runtime-neutral). JsonCodec uses
// TextEncoder/TextDecoder; binary codecs (msgpack, protobuf) drop in unchanged.
interface Codec {
  encode(value: unknown): Bytes;
  decode(body: Bytes): unknown;
}

interface Clock { now(): Date; }

// Observability port — real metrics/logs in prod, no-op fake in tests.
// Best-effort and never load-bearing: implementations MUST NOT throw, and the
// core guards every call (§11) so a misbehaving probe can never make dispatch
// reject after a successful publish, nor block an ack/nack. Synchronous, no
// control-flow side-effects.
interface Probe {
  dispatched(topic: Topic): void;
  processed(sub: Subscription, msg: DeliveredMessage): void;
  failed(sub: Subscription, msg: DeliveredMessage, error: unknown): void;
  deadLettered(sub: Subscription, msg: DeliveredMessage): void;
}
```

### Core application services

```ts
// Producer side. Frames the versioned envelope (stamping dispatchedAt from the
// injected Clock — no global time) and publishes its bytes.
class Dispatcher {
  constructor(
    private readonly publisher: Publisher,
    private readonly codec: Codec,
    private readonly clock: Clock,
    private readonly probe: Probe,
  ) {}

  async dispatch(topic: Topic, payload: unknown): Promise<void> {
    const body = Envelope.frame({
      dispatchedAt: this.clock.now(),
      payload: this.codec.encode(payload),
    });
    await this.publisher.publish(topic, body); // durable side-effect first
    this.probe.dispatched(topic);              // best-effort; guarded (§11)
  }
}

// Consumer side. Owns the retry/dead-letter POLICY; calls broker primitives.
class Worker {
  constructor(
    private readonly consumer: Consumer,
    private readonly publisher: Publisher, // for dead-letter
    private readonly codec: Codec,
    private readonly probe: Probe,
  ) {}

  // Rejects a duplicate {topic, name}: two subs sharing a name would share one
  // consumer group and split work, silently destroying per-handler isolation.
  register(sub: Subscription): void { /* throw on duplicate {topic, name} */ }
  async start(): Promise<void> { /* consume() each registered subscription */ }
  async stop(): Promise<void> { /* stop running consumers */ }

  // The core processing rule (sketch). Broker side-effects happen first; probe
  // calls are last and guarded (§11), so they can never prevent an ack/nack.
  // The dead-letter branch only fires on a REDELIVERY (count > maxAttempts); a
  // fresh delivery is always count 1, so it always attempts. Attempt-accounting
  // and the slow-but-healthy hazard are pinned down in §8.
  private async process(sub: Subscription, msg: DeliveredMessage) {
    if (msg.deliveryCount > sub.props.retry.props.maxAttempts) {
      await this.publisher.publish(this.deadLetterTopic(sub, msg.topic), msg.body);
      await msg.ack();
      this.probe.deadLettered(sub, msg); // guarded
      return;
    }
    try {
      const env = Envelope.parse(msg.body);
      const event = new Event({
        topic: msg.topic,
        payload: this.codec.decode(env.payload),
        id: msg.id,                       // broker-assigned
        deliveryCount: msg.deliveryCount, // broker-tracked
        dispatchedAt: env.dispatchedAt,   // from the envelope
      });
      await sub.props.handler.handle(event);
      await msg.ack();
      this.probe.processed(sub, msg); // guarded
    } catch (error) {
      await msg.nack();                    // redelivered later; count increments
      this.probe.failed(sub, msg, error);  // guarded, AFTER nack
    }
  }
}
```

Note the **retry policy lives in `Worker`** (the core), not the adapter. The
adapter's contract is narrow: deliver fresh messages with `deliveryCount === 1`,
redeliveries with the broker's count, and honor `ack`/`nack`. This is what makes
the whole retry/dead-letter behavior unit-testable against a `FakeBroker` — and
the fake **must** let a test drive the two occasions distinctly (deliver fresh
vs. redeliver with count N), because Redis cannot merge them (§7/§8). Building the
fake around "count is accurate on every delivery, dead-letter inline" would pass
tests the real adapter can't satisfy.

### Public facade (event-emitter-like)

The surface app code touches wraps `Dispatcher` + `Worker` so the common case
reads like an event emitter:

```ts
// `namespace` (your service identity) prefixes every consumer-group id, so two
// services subscribing the same handler name to the same topic stay isolated
// instead of accidentally sharing one group. Stable per service.
const flume = new Flume({ namespace: "billing", broker, codec, clock, probe });

// produce — async + durable (not EventEmitter's synchronous, in-process emit)
await flume.emit("user.created", { userId: "123" });

// consume — a durable subscriber needs a STABLE name (→ consumer group)
flume.on("user.created", "send-welcome-email", new SendWelcomeEmail(mailer), {
  retry: new RetryPolicy({ maxAttempts: 5 }),
  delivery: DeliveryMode.Competing,
});

await flume.start();
```

`emit` delegates to `Dispatcher.dispatch`; `on` constructs a `Subscription` and
registers it with the `Worker`. The facade is thin convenience — the underlying
objects stay public for tests and advanced wiring.

**The one hard constraint:** a pure `on(event, fn)` (anonymous listener) carries
no durable identity, and per-handler retry isolation requires a **stable name
per subscriber** that survives restarts and is shared across instances — it *is*
the consumer group. **Canonical form: `on(topic, name, handler, opts)`** — the
name is an explicit, stable string at the registration site (most emitter-like,
and visible exactly where consumer groups are wired). The full durable group
identity is `{namespace}:{name}`; `Worker.register` rejects duplicate
`{topic, name}`. This is the deliberate departure from `EventEmitter` that makes
"classic event-system guarantees" possible; renaming `namespace` or `name`
orphans the old group's pending messages.

---

## 6. Dispatch flow & wire format

**Wire format — a versioned envelope.** Every message is framed as
`{ v: 1, dispatchedAt, payload }`, where `payload` is the user `Codec`'s output
and the rest is core-owned metadata. The version field keeps future additions
(schema id, trace context) non-breaking. Envelope framing is a fixed core
concern, distinct from the swappable payload `Codec`. On Redis these map to
stream fields (`XADD topic * v 1 ts <dispatchedAt> payload <bytes>`); at the port
level it is opaque `body: Bytes`.

Dispatch:

1. App calls `dispatcher.dispatch(topic, payload)`.
2. `Codec.encode(payload)` → payload bytes.
3. Frame the envelope, stamping `dispatchedAt` from the injected `Clock`.
4. `Publisher.publish(topic, body)` → broker stores the message (durable).
5. `Probe.dispatched(topic)` — best-effort, guarded.

On the consume side the `Worker` parses the envelope, decodes the payload, and
builds the `Event` with `id` / `deliveryCount` from the broker and `dispatchedAt`
from the envelope. The producer knows nothing about who subscribes — it only
writes to a topic. (`dispatchedAt` is producer clock time: informational, subject
to cross-machine clock skew, **not** an ordering key — the broker-assigned `id`
is the ordering/idempotency reference.)

---

## 7. Processing flow (retry, ack, dead-letter)

Redis surfaces a message on two distinct occasions, and the `Worker` handles them
differently — through one `deliver` callback, keyed on `deliveryCount`:

- **Fresh delivery** (`XREADGROUP >`, `deliveryCount === 1`): decode + run the
  handler. Success → `ack` (+ `processed`). Throw → `nack` (+ `failed`); `nack` is
  a no-op that leaves the entry pending — *nothing redelivers it immediately*, the
  reclaim loop will, after `minIdleTime`.
- **Redelivery** (reclaim via `XAUTOCLAIM`, `deliveryCount > 1`): the **only**
  occasion with an authoritative count, so the **only** place the dead-letter
  decision is made. `deliveryCount > maxAttempts` → publish to the handler's
  dead-letter stream (`{topic}:dead:{name}`), `ack` the original, emit
  `deadLettered`. Otherwise run the handler again (ack/nack as above).

So a failing message's retry latency is `~minIdleTime` per attempt (reclaim-
driven), and dead-lettering happens on the reclaim pass that pushes the count past
`maxAttempts` — never inline on a fresh delivery. Attempt-accounting and the
slow-but-healthy hazard are pinned down in §8.

Because each handler has **its own consumer group** (§8), handler A reaching
dead-letter has no effect on handler B's processing of the same event. This
isolation depends on `{topic, name}` being unique per handler — `Worker.register`
rejects duplicates at wiring time so a copy-pasted name can't silently merge two
handlers into one shared group.

---

## 8. Redis Streams adapter

Maps Flume concepts onto Redis Streams, reusing the techniques proven in
`streams-connector`:

| Flume concept                  | Redis Streams |
|--------------------------------|---------------|
| Topic                          | stream key (`XADD topic * payload <bytes>`) |
| Subscription (per handler)     | consumer group `flume:{sub.name}` on the topic stream |
| Competing consumers            | multiple consumers in the **same** group → load splits |
| Broadcast                      | a **per-instance** group `flume:{sub.name}:{instanceId}` → every instance sees every message |
| Delivery                       | `XREADGROUP GROUP flume:{sub.name} {consumer} … BLOCK … COUNT …` |
| `deliveryCount`                | `1` on fresh `XREADGROUP >` (no count returned → attempt 1, no extra call); on reclaim, the count from `XAUTOCLAIM`/`XPENDING` |
| Redelivery / reclaim           | periodic `XAUTOCLAIM` of messages idle past `minIdleTime`; **it increments the delivery count as it claims** (non-`JUSTID`) — see *Attempt accounting* |
| ack                            | `XACK` |
| nack                           | no-op (leave in PEL) → reclaimed after idle |
| dead-letter                    | per-handler stream `{topic}:dead:{name}`: the **core frames a `DeadLetter` body** `{originalId, body}` (the id only exists at consume time) and `publish`es it through the generic Publisher; the adapter `XADD`s that body then `XACK`s the original, and MAY also surface `originalId` as a stream field for dedup/redrive — no core change needed |
| group creation                 | idempotent `XGROUP CREATE … <start> MKSTREAM`, catch `BUSYGROUP` |
| group start position            | `$` (default — only events after the group is created; a newly-added handler does **not** see in-flight/historical events) or `0` (replay history), from `subscription.startFrom` |

**Namespace lives in `sub.name`, not the adapter.** The `Flume` facade folds its
`namespace` into every registered subscription name, so `sub.name` is already
`{namespace}:{registeredName}` (e.g. `billing:send-welcome`). The adapter therefore
only prefixes `flume:` and never needs to know the namespace — `namespace` has a
single home (the facade), and the broker port stays fully transport-generic.

**Clients.** Reuse `streams-connector`'s separation: a blocking read client, a
reclaim client, and a write client (a blocking `XREADGROUP` holds its connection
for up to the read timeout; multiplexing other commands behind it would
serialize). **Client: `redis` v6 (node-redis)** — proven in-repo by
`streams-connector` for exactly these ops (`XAUTOCLAIM`/`XPENDING`), and keeping
one Redis client across the monorepo avoids dependency sprawl. (If hard cluster /
sentinel resilience later demands it, `ioredis` is the battle-tested fallback —
revisit per-adapter, not now.)

**Binary reads (don't corrupt non-UTF-8 payloads).** node-redis v6 defaults to
RESP3 and returns **strings** for blob replies, so a binary `Uint8Array` wire is
not free: read clients must map blob strings to `Buffer`
(`withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer })`) and the stream commands
need `unstableResp3: true` (or pin `RESP: 2`), or `XREADGROUP` transforms throw.
Skip this and a JSON payload survives by luck, but a msgpack/protobuf codec gets
silently UTF-8-mangled — the exact feature we advertise. M2 must include a
**non-UTF-8 round-trip test** (e.g. bytes `0xFF 0xFE`); JSON-only tests won't catch it.

**Retry timing.** Redis Streams has no native per-message delay. A `nack`'d
message is redelivered when the reclaim loop next picks it up after `minIdleTime`.
So retry *cadence* is **broker configuration** (reclaim `minIdleTime` / `interval`),
not a per-subscription promise — which is exactly why `RetryPolicy` carries only
`maxAttempts` in v1 (§5). A precise per-message backoff curve would need a
scheduler (BullMQ-style delayed sets) and is a deferred enhancement, not v1.

**Attempt accounting (and the slow-consumer hazard).** Pin to **non-`JUSTID`**
`XAUTOCLAIM`, which increments the delivery count as it claims. Mapping: fresh
delivery = attempt 1 (count 1); each reclaim = the next attempt, count already
incremented by the claim. Rule: in the reclaim path, `deliveryCount > maxAttempts`
→ dead-letter (don't invoke); else invoke. That yields exactly `maxAttempts`
handler invocations — **verify the boundary in M1 unit tests (`maxAttempts` 1 and
2).** The hazard: because the *act of reclaiming* bumps the count, reclaiming a
**slow-but-healthy** in-flight message (not a failed one) inflates its count and
could dead-letter work that never failed. Two mitigations, both required: set
`minIdleTime` safely above the **max expected handler duration**, and **gate
reclaim on local throughput** (as `streams-connector` does — only reclaim when
this consumer is underloaded, i.e. the message is likely abandoned, not in-flight).

**No Lua, and provider compatibility.** Everything above is a plain native
command — **no `EVAL`** (see §1/§2). Where two writes must both land (dead-letter
= `XADD` to the dead stream, then `XACK` the original), we lean on
**at-least-once** instead of a Lua/`MULTI` transaction: a crash between the two
just redelivers the message, which re-dead-letters it — consistent with our
guarantees, dedupable, and far cheaper than blocking the server. Two
compatibility notes: `XAUTOCLAIM` needs **Redis ≥ 6.2**, and the blocking
`XREADGROUP` loop needs a **TCP Redis that supports `BLOCK`** — a pure
HTTP/serverless Redis would force a polling fallback (open Q §15).

**Retention / trimming — at-least-once safety.** `MAXLEN ~` trimming on a *live*
topic stream is **unsafe**: it deletes entries by age/count regardless of whether
every consumer group has read them, so a slow handler's group can lose unread
messages — breaking at-least-once (with per-handler groups, the slowest group
sets the floor). Therefore **live topic streams are not `MAXLEN`-trimmed by
default.** Safe reclamation, when needed, trims by `XTRIM … MINID <id>` where the
id is the **minimum last-delivered id across all groups** (`XINFO GROUPS`) — never
above what some group still needs. The **dead-letter** stream *may* use
`MAXLEN ~` (it is already a terminal, loss-tolerant sink). The cost we accept:
unbounded live-stream growth without a reaper; the MINID reaper is the sanctioned
mitigation, not naive `MAXLEN`.

**Broadcast group lifecycle.** Broadcast uses a **per-instance** group, so a dead
instance (autoscale-down, redeploy, crash) leaves an **orphaned group** whose
last-delivered-id freezes forever. Two failures: orphan groups accumulate on hot
streams (memory + `XINFO GROUPS` bloat), and — worse — a frozen group **pins the
MINID reaper** (the min last-delivered-id across groups never advances), silently
disabling all live-stream trimming. So broadcast requires a group reaper:
heartbeat/TTL per instance, `XGROUP DESTROY` for groups whose heartbeat expired,
and the MINID computation must **exclude dead/expired groups**. Design this before
broadcast ships (M3) — without it, broadcast is a slow memory leak in any elastic
fleet. (Competing mode is unaffected: siblings reclaim a dead consumer's PEL
within the shared group.)

---

## 9. Multi-machine / scaling semantics

This was called out as a first-class concern. Most of it is handled by the
broker adapter, but the contract the core guarantees:

- **Competing consumers (default).** Instances of the same handler share one
  consumer group → each event is processed once across the fleet. Add machines →
  throughput scales. Each process must use a **unique consumer name** (default:
  `{host}:{pid}`, overridable) so reclaim can steal from crashed instances.
- **Broadcast (opt-in).** Each instance gets its own group → every instance
  processes every event. For cache invalidation / fanout. Per-instance groups
  **must be reaped** (§8 *Broadcast group lifecycle*) — orphaned groups otherwise
  leak and freeze the MINID reaper.
- **Crash recovery.** Messages stuck in a dead consumer's pending set are
  reclaimed by survivors after `minIdleTime` → at-least-once preserved.
- **Producer/consumer split.** The API tier constructs a `Dispatcher` (Publisher
  only); the worker tier constructs a `Worker` (Consumer + Publisher for DLQ).
  One process can do both. This replaces bee's `enableListeners`/`enableWorkers`
  booleans with explicit object composition.
- **No global ordering** across instances; **at-least-once**, so **handlers must
  be idempotent**. Stated loudly because it's the #1 correctness footgun.
- **Idempotency key.** `Event.id` is the broker-assigned message id, stable across
  redeliveries — handlers dedup on it. (At-least-once guarantees a handler can see
  the same id more than once.)
- **Connection cost of per-handler groups (a hard limit, not a TODO).** Each
  subscription runs its own blocking `XREADGROUP` (which monopolizes a
  connection), plus the shared reclaim and write clients — so a worker holds
  `≈ subscriptions + 2` connections, per instance. This **cannot** be multiplexed
  away: one `XREADGROUP` reads many streams but only for a single group, and our
  groups are per-handler. At ~40 handlers × 20 instances that's ~840 connections —
  check it against your managed-Redis connection cap. It's a real ceiling on
  handlers-per-worker, stated as such (not a deferred optimization).

---

## 10. Configuration (indicative)

- **Flume (app-level):** `namespace` — your service identity; the facade folds it
  into every subscription's name (`{namespace}:{name}`) so services don't
  accidentally share a group. The broker never sees `namespace` separately. Must
  be stable per service.
- **Broker (Redis):** connection options, `instanceId` / consumer name,
  `readTimeout`, reclaim `interval` / `minIdleTime` / `count`. Retry *cadence*
  lives here (reclaim timing), not on `RetryPolicy`. **No `MAXLEN` on live
  streams** (§8); optional dead-letter `maxLen` and an optional MINID-reaper
  interval.
- **Per subscription:** `topic`, `name` (durable group identity, **unique per
  topic**), `retry` (`maxAttempts` only), `delivery` (Competing | Broadcast),
  `startFrom` (`"new"` default | `"beginning"`).
- **Codec:** `JsonCodec` default; swap for any `Codec` implementation. The
  versioned envelope framing (§6) is core-owned and not swappable.

---

## 11. Observability

A `Probe` port declares business-relevant events: `dispatched`, `processed`,
`failed`, `deadLettered`. Production wiring emits metrics/logs; tests use a
no-op/recording fake. Keeps observability decoupled from the processing logic.

**Best-effort, never load-bearing.** Probe implementations must not throw, and
the core guards every probe call (wraps it, swallows errors) so observability can
never change messaging behavior — a thrown probe must not make `dispatch` reject
after a successful publish, nor prevent an `ack`/`nack`. Broker side-effects
always complete before the probe call, and the probe call is always last in its
branch (§5).

---

## 12. Testing strategy

- **Core (fast, no infra):** unit tests with an in-memory **`FakeBroker`**, a
  **`FakeClock`**, and a recording **`FakeProbe`**. The `FakeBroker` must let a
  test drive **fresh delivery (count 1) and redelivery (count N) distinctly** (§5)
  and assert `ack`/`nack` — not just "push a message", or the suite encodes
  semantics the Redis adapter can't honor. These cover dispatch, fresh vs.
  redelivery processing, attempt-accounting boundaries (`maxAttempts` 1 and 2,
  §8), dead-letter routing, duplicate-name rejection, and **a throwing `FakeProbe`
  that must not break ack/nack/dispatch** (§11) — the actual domain rules, without
  Docker. Hand-written fakes only; no `vi.fn()` for domain deps.
- **Redis adapter (integration):** tests against real Redis via
  `docker compose` (`pretest`/`posttest`), mirroring `bee` and
  `streams-connector`. Needs its **own host port to coexist** — `bee` uses 6380,
  `streams-connector` uses 6379, so Flume → **6381**.
- The bee test scenarios are the acceptance bar for behavior: "only processes
  when delivered", "each handler processed independently", "a failing handler
  doesn't affect others", "exhausted handler dead-letters and acks".

---

## 13. Package layout, module boundaries & dependencies

v1 ships as **one package** (`@joaofnds/flume`) but with a **hard boundary**
between core and adapter, surfaced as **separate entry points**, so extracting
`@joaofnds/flume-redis` / `@joaofnds/flume-nats` later is a lift-and-shift, not a
refactor.

```
packages/flume/
  src/
    domain/        Topic, Event, RetryPolicy, DeliveryMode, Subscription, EventHandler
    application/   Dispatcher, Worker, Flume (facade)
    ports/         Publisher, Consumer, Codec, Clock, Probe
    codec/         JsonCodec        (dependency-free, core default)
    clock/         SystemClock      (dependency-free, core default)
    testing/       FakeBroker, FakeClock, FakeProbe
    adapters/
      redis/       RedisStreamsBroker (Publisher + Consumer)   ← isolated
    index.ts       core entry  — exports domain / application / ports / codec / clock
    redis.ts       adapter entry — exports the Redis adapter only
  test/            integration tests (docker compose Redis on 6381)
  compose.yaml
```

**Entry points (`exports` map in `package.json`):**

- `@joaofnds/flume` → core. **Zero runtime dependencies; never `require`s a
  broker client.** This is exactly what a future `flume-nats` would depend on.
- `@joaofnds/flume/redis` → the Redis Streams adapter; the **only** path that
  pulls in `redis`.
- `@joaofnds/flume/testing` → fakes, for consumers' own tests.

**Dependency rule, made physical:** `adapters/redis` imports only from `ports/`
and `domain/`; nothing in `domain/` `application/` `ports/` `codec/` `clock/`
may import from `adapters/`. The core never learns a broker exists. This is the
precondition for splitting packages cleanly — and a lint/boundary check should
enforce it so the arrow can't silently reverse.

- **Core** (`.`): zero runtime deps — pure TypeScript.
- **`redis` is an *optional `peerDependency`*** of `@joaofnds/flume`, not a
  regular `dependency`. Subpath exports stop runtime *loading*, but a normal
  `dependency` would still **install** `redis` for every consumer — including
  core-only and future NATS users — so "zero runtime deps" would be false at
  install time. As an optional peer, only apps that import `@joaofnds/flume/redis`
  install it. (The package also lists `redis` as a `devDependency` so its own
  integration tests run.) When the adapter is later extracted to
  `@joaofnds/flume-redis`, `redis` becomes that package's own direct dependency.
- **`@joaofnds/throughput` gets the *same* optional-peer treatment.** The Redis
  adapter gates its reclaim loop on local throughput (§8 slow-but-healthy
  mitigation), so it depends on `@joaofnds/throughput` — but only under `./redis`.
  Making it a regular `dependency` would install it for core-only/NATS consumers
  too, so it is an **optional `peerDependency`** (+ `devDependency` for the
  tests/benchmark), exactly like `redis`. It also becomes a direct dependency of
  `@joaofnds/flume-redis` on extraction.
- `JsonCodec`, `SystemClock`: dependency-free, shipped as core defaults.

**Future split.** Publishing `@joaofnds/flume-redis` / `@joaofnds/flume-nats`
turns each adapter into its own package that depends on `@joaofnds/flume` (core)
and declares its own client dep (`redis`, `nats`, …). Because the boundary
already holds, the move is: relocate the adapter folder, repoint the import
specifier, add a `package.json`. No core changes. The NATS adapter is the
intended **second** implementation — its real job is to prove the broker port is
genuinely transport-agnostic, not Redis-shaped.

---

## 14. Milestones

1. **M1 — Core + fakes.** Domain model, ports, `Dispatcher`, `Worker` (retry +
   dead-letter policy), `FakeBroker`/`FakeClock`/`FakeProbe`, full unit suite. No
   real infra. *This is where the design is validated.*
2. **M2 — Redis Streams adapter.** The `@joaofnds/flume/redis` entry point (§13):
   Publisher + Consumer with per-handler groups, reclaim, dead-letter; integration
   tests against Redis on 6381. **Plus a throughput benchmark vs a BullMQ
   baseline** (reuse `@joaofnds/throughput`) to test the "leaner than Bull"
   hypothesis with numbers, not assertions.
3. **M3 — Scaling, ops & ergonomics.** Broadcast mode **+ its group reaper** (§8),
   unique consumer-name defaults, producer/consumer-split wiring docs, `Probe`
   production impl, and a **DLQ redrive** utility (read `{topic}:dead:{name}` →
   re-publish to `{topic}`, idempotent on the original id). v1 at minimum documents
   the manual redrive procedure so it isn't discovered mid-incident.
4. **M4 (later) — NestJS adapter.** Driving adapter: a module that wires
   `Dispatcher`/`Worker` into DI and (optionally) restores decorator ergonomics
   on top of the OOP core.
5. **M5 (later) — More brokers.** NATS (JetStream maps cleanly: ack/nak/term +
   delivery count), then RabbitMQ, then Kafka (the impedance mismatch — see §16).

---

## 15. Open questions

1. **Dead-letter topology — RESOLVED.** Per-handler streams `{topic}:dead:{name}`.
   Mirrors the per-handler group model, keeps failures isolated, and makes
   re-drive per handler unambiguous — the standard DLQ-per-consumer pattern.
2. **Retry backoff — RESOLVED.** `RetryPolicy` is `maxAttempts`-only in v1; retry
   *cadence* is broker reclaim config (§8). Precise per-message backoff needs a
   scheduler and is deferred — the port has no delay primitive.
3. **Facade subscribe signature — RESOLVED.** Canonical `on(topic, name, handler,
   opts)` (explicit stable name). Full group identity `{namespace}:{name}`;
   `Worker.register` rejects intra-process duplicates (§5). `Dispatcher`/`Worker`
   stay public under the facade.
4. **Wire envelope — RESOLVED.** Versioned envelope `{ v, dispatchedAt, payload }`
   from v1 (§6): `dispatchedAt` is stamped by the `Dispatcher`'s `Clock`; the
   version field keeps future additions non-breaking. Payload bytes come from the
   swappable `Codec`; framing is core-owned.
5. **`Bytes` type — RESOLVED.** `Uint8Array` at the codec/port boundary — runtime-
   neutral (Node + edge), binary-clean for msgpack/protobuf. Adapters convert at
   the edge (Redis ↔ Buffer/string); `JsonCodec` uses `TextEncoder`/`TextDecoder`.
6. **Redis client — RESOLVED.** `redis` v6 (node-redis) — proven in-repo for these
   exact Streams ops, no second Redis client in the monorepo. `ioredis` is the
   fallback if cluster/sentinel resilience later forces it (§8).
7. **Serverless / HTTP Redis — RESOLVED.** v1 targets **TCP Redis** only (blocking
   `XREADGROUP` holds). An HTTP/serverless polling consumer is out of scope for
   v1; revisit per-adapter if a REST-only provider becomes a target later.

---

## 16. Future adapters & known impedance mismatches

Each future broker ships as its **own package** depending on the core (§13) —
`@joaofnds/flume-nats`, `@joaofnds/flume-rabbit`, …. The broker port assumes
**per-message ack + a broker-tracked delivery count + redelivery**. This fits
Redis Streams, NATS JetStream, and RabbitMQ well. **Kafka is the outlier**: offset-based commits, no per-message ack, no native per-message
delivery count, and "dead letter" means producing to another topic. When the
Kafka adapter is built it will likely need a different retry strategy (e.g.
offset-tracking + a side structure for attempt counts, or a retry-topic ladder).
We deliberately **do not** generalize the port for Kafka now (YAGNI) — we note it
so the v1 port shape isn't mistaken for the final word.
