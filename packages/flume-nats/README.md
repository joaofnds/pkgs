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
pnpm add @joaofnds/flume @joaofnds/flume-nats nats
```

`nats` is a peer dependency — bring your own client version.

## How it maps onto JetStream

- **One stream** (`flume`) binds the `flume.>` wildcard; every topic is published under
  a `flume.` prefix, so arbitrary topic strings (including the `{topic}:dead:{name}`
  dead-letter subjects the core Worker produces) are captured without per-topic setup.
- **One durable consumer per (topic, subscription)**, keyed like Redis's per-stream
  group. Competing consumers share a durable and JetStream load-balances across the
  bound clients; **broadcast** appends the `instanceId` so every instance owns a durable
  and sees every event.
- **Delivery count** comes from JetStream's `redeliveryCount` (1 on the first delivery,
  broker-tracked on redelivery); `nack()` maps to `nak()` and `ack()` to a fire-and-forget
  `msg.ack()` (a lost ack just redelivers after `ack_wait`, so at-least-once holds without
  paying a confirmation round-trip per message). `max_deliver` is unlimited — the core
  `Worker` owns the dead-letter decision and acks to stop redelivery.

## Performance

The adapter dispatches up to `readCount` deliveries concurrently (the same concurrency
knob as the Redis adapter) and defaults the connection to `noAsyncTraces: true`
(overridable via your `nats` options) to skip the v2 client's per-request stack capture.
Confirmed publishes keep their JetStream PubAck, so durability is unchanged. Together with
fire-and-forget acks this puts throughput within ~1–1.6× of the Redis adapter (see
`@joaofnds/flume-bench`), up from ~21× slower.

## Capabilities

It passes the `@joaofnds/flume-tck` broker contract for `redelivery`,
`startFromBeginning`, and `broadcast`. Dead-letter **redrive** is not yet implemented
(`redrive: false`); dead-lettering itself works (the Worker publishes to a dead subject
and acks), only the replay utility is pending.

> Note: this adapter currently targets the `nats` v2 client, which upstream has
> deprecated in favor of the `@nats-io/*` v3 packages. A migration is a tracked
> follow-up; the JetStream semantics above are unaffected.

## License

MIT
