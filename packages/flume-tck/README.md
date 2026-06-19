# @joaofnds/flume-tck

A broker **contract test kit** for [`@joaofnds/flume`](../flume): one suite of
port-level behaviors that every `Broker` adapter must satisfy, so a new adapter
proves its conformance by running the shared suite instead of re-writing the tests.

It is a **source-only, test-time** package — it ships TypeScript, never a build, and
is consumed under the adapter's own vitest (which transforms it). Production code
never imports it.

## Usage

In an adapter package, add it as a dev dependency and call `brokerContractTests` from
a test file with a factory that produces a connected broker against your real backend:

```ts
// packages/flume-redis/test/conformance.test.ts
import { brokerContractTests } from "@joaofnds/flume-tck";
import { RedisStreamsBroker } from "../src/index";

brokerContractTests<RedisStreamsBroker>("RedisStreamsBroker", {
  capabilities: {
    redelivery: true,
    startFromBeginning: true,
    broadcast: true,
    redrive: true,
  },
  async makeBroker(options) {
    const broker = new RedisStreamsBroker({
      redis: { url: "redis://localhost:6381" },
      consumerName: options?.consumerName,
      instanceId: options?.instanceId,
      /* test-fast reclaim / broadcast tuning */
    });
    await broker.connect();
    return broker;
  },
  closeBroker: (broker) => broker.close(),
  redrive: (broker, args) => broker.redriveDeadLetters(args),
});
```

Because it's source-only, the adapter's vitest config must transform it rather than
externalize it:

```ts
// vitest.config.ts
test: { server: { deps: { inline: [/@joaofnds\/flume-tck/] } } }
```

## What it covers

The suite asserts **observable port behavior** — never broker internals. It drives the
`Broker` port (`publish` / `consume`) and the `Flume` facade, observes via the handler's
recorded events and by consuming the dead-letter topic, and uses no backend
introspection. Adapter-internal mechanics (Redis PEL, reclaim cursors, NATS ack_wait)
stay in the adapter's own tests.

Always-run behaviors: fresh delivery with `deliveryCount` 1, non-UTF-8 round-trip,
exactly-once processing, `startFrom:"new"`, and competing-consumer load balancing.

Capability-gated behaviors (a broker declares what it supports; the rest are skipped):

| Capability | Behaviors |
| --- | --- |
| `redelivery` | nacked redelivery with incremented count; the maxAttempts 1 & 2 dead-letter boundaries; sibling-handler isolation |
| `startFromBeginning` | replays events published before the subscription |
| `broadcast` | every instance receives every event |
| `redrive` | re-publishes a dead-letter so the handler reprocesses; reports zero on an empty stream (requires a `redrive()` hook) |

## License

MIT
