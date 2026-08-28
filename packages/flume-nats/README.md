# @joaofnds/flume-nats

NATS [JetStream](https://docs.nats.io/nats-concepts/jetstream) broker adapter for
[`@joaofnds/flume`](../flume) — durable, at-least-once event processing backed by a
JetStream stream and per-handler durable consumers.

```ts
import { Flume, JsonCodec, SystemClock, LoggingProbe } from "@joaofnds/flume";
import { NatsStreamsBroker } from "@joaofnds/flume-nats";

const broker = new NatsStreamsBroker({ nats: { servers: "nats://localhost:4222" } });
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

await flume.stop();
await broker.close();
```

## Install

```
pnpm add @joaofnds/flume @joaofnds/flume-nats @nats-io/transport-node @nats-io/jetstream
```

`@nats-io/transport-node` and `@nats-io/jetstream` are peer dependencies — bring your
own client version.

## How it maps onto JetStream

- **One stream** (`flume`) binds the `flume.>` wildcard; every topic is published under
  a `flume.` prefix, so arbitrary topic strings (including the `{topic}:dead:{name}`
  dead-letter subjects the core Worker produces) are captured without per-topic setup.
- **One durable consumer per (topic, subscription)**, keyed like Redis's per-stream
  group. Competing consumers share a durable and JetStream load-balances across the
  bound clients; **broadcast** appends the `instanceId` so every instance owns a durable
  and sees every event.
- **Delivery count** comes from JetStream's `deliveryCount` (1 on the first delivery,
  broker-tracked on redelivery); `nack()` maps to `nak()` and `ack()` to a fire-and-forget
  `msg.ack()` (a lost ack just redelivers after `ack_wait`, so at-least-once holds without
  paying a confirmation round-trip per message). `max_deliver` is unlimited — the core
  `Worker` owns the dead-letter decision and acks to stop redelivery.

## Performance

The adapter dispatches up to `concurrency` deliveries at a time (default 10; 1 means
serial delivery). Unlike the Redis adapter, where `readCount` is the `XREADGROUP` batch
size and dispatch is batch-gated on the slowest handler, this is a sliding pool: a new
pull starts as soon as any in-flight delivery finishes. The JetStream pull buffer that
backs it (`max_messages` = `max(concurrency, 2)`) is derived, not caller-set — two is the
smallest buffer the client can make progress on, so `concurrency: 1` still asks for a
buffer of 2. That second buffered message's server-side `ackWait` clock runs while the
first is handled, so a handler whose duration approaches `ackWait` risks its redelivery.

The adapter defaults the connection to `noAsyncTraces: true` (overridable via your
connection options) to skip the client's per-request stack capture. Confirmed publishes
keep their JetStream PubAck, so durability is unchanged. Together with fire-and-forget
acks this puts throughput within ~1–1.6× of the Redis adapter (see
`@joaofnds/flume-bench`), up from ~21× slower.

Those figures were measured on the deprecated `nats` v2 client, before the `@nats-io/*` v3
port; the sweep has not been re-run on v3.

## Capabilities

It passes the `@joaofnds/flume-tck` broker contract for `redelivery`,
`startFromBeginning`, and `broadcast`. Dead-letter **redrive** is not yet implemented
(`redrive: false`); dead-lettering itself works (the Worker publishes to a dead subject
and acks), only the replay utility is pending.

## License

Apache-2.0. See [LICENSE](LICENSE).
