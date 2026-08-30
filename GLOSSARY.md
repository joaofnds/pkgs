# Glossary

Domain terms as used across this repo's packages, conversation, code, and tests.
Each entry names the authoritative source where one exists. Add terms as they are
settled; a term with two meanings is a modeling question for João, not a silent
choice.

## Messaging core (flume)

- **ack** — the broker call that settles a delivered message as done and removes it
  from the pending set (Redis: XACK). Port: `DeliveredMessage.ack()`.
- **ack failure** — an ack the broker refuses (connection down, client closed). An
  infrastructure fault, distinct from a handler failure: the handler already
  succeeded. Reported via `Probe.ackFailed` and propagated to the adapter's read
  loop; never nacked. (`packages/flume/PRD.md` §11, PKGS-27.)
- **nack** — the message stays pending for later redelivery. In flume-redis a
  documented no-op: the reclaim loop redelivers after `minIdleTime`.
- **at-least-once** — the delivery guarantee: a message may be delivered and
  processed more than once, never silently dropped. Handlers are expected to be
  idempotent.
- **fresh delivery** — a first read (`XREADGROUP >`); `deliveryCount` is 1 by
  definition, with no broker round-trip.
- **redelivery / reclaim** — the adapter re-delivering a pending message
  (Redis: `XAUTOCLAIM` after `minIdleTime`); the broker supplies the authoritative
  `deliveryCount`. Retry *policy* is the core's; retry *mechanics* are the adapter's.
- **retry budget / exhaustion** — `RetryPolicy.maxAttempts` handler invocations;
  a redelivery whose count exceeds it (`sub.retry.exhaustedBy`) is dead-lettered
  without running the handler. `deliveryCount` is broker-owned, so infrastructure
  faults (ack failures) also consume the budget — accepted on PKGS-27.
- **dead-letter (DLQ)** — parking an exhausted message on `{topic}:dead:{name}`
  as a `DeadLetter` frame, then acking the original. Decision is the core
  `Worker`'s; the adapter has no dead-letter code path.
- **redrive** — operator-invoked re-publish of a dead-letter stream back onto its
  live topic, idempotent on `originalId` (flume-redis).
- **competing / broadcast** — `DeliveryMode`: one shared consumer group splitting
  work, versus a per-instance group so every instance sees every event.
- **subscription name** — the durable identity `{namespace}:{name}`; it *is* the
  consumer group. Renaming it orphans the old group's pending.

## Observability

- **Probe (core)** — the business-event port: dispatched, dispatchFailed,
  processed (with timing), failed, ackFailed, deadLettered. Guarded intrinsically
  (`GuardedProbe`); best-effort, never load-bearing.
- **BrokerProbe (adapter)** — each adapter's operational port (connection
  lifecycle, reclaim/reap/heartbeat, stalls). Kept off the core Probe so broker
  mechanics never leak through the hexagonal port.
- **symptom vs cause** — the log-level rule (`ProbeLogger` TSDoc,
  `.boris/CONTEXT.md`): a member reporting impact is a symptom and logs at
  `error`; a cause flume works around on its own may log at `warn` only when its
  impact reaches an error-level symptom event on a path nameable in the source.
- **stopped / stalled / degraded** — the consumer-health events
  (`.boris/CONTEXT.md`): the delivery loop ended and nothing restarts it; the loop
  runs but messages aren't arriving and retries aren't clearing it; the loop runs
  and messages arrive at a cost. flume-redis emits stopped and stalled only.

## Testing

- **TCK / contract suite** — `@joaofnds/flume-tck`'s `brokerContractTests`: the
  cross-adapter port contract, run by each adapter against its real backend,
  asserting observable behavior only (no backend introspection, no fault
  injection). Behavior needing a fault seam is pinned in the core suite instead.
- **deliverFresh / redeliver** — `FakeBroker`'s two distinct drivers, kept
  separate because the Redis adapter cannot honor "count accurate on every
  delivery".
