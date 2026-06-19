# @joaofnds/flume-bench

Comparative benchmark harness for [`@joaofnds/flume`](../flume) adapters. It imports
every adapter and a BullMQ baseline and runs them through the same matrix on the same
Redis, so the numbers are directly comparable. Private (never published).

```
pnpm --filter @joaofnds/flume-bench bench
```

Runs `benchmark/throughput.bench.ts` via tsx with `--expose-gc` (mitata wants manual
GC) inside a docker-compose Redis (port 6381). For each variant (payload × count ×
concurrency) it reports, all on the same backend:

- **throughput** — msg/s from mitata's median op time (warmup + multiple samples)
- **latency** — per-message dispatch→process p50/p95/p99 under burst
- **redis ops** — data-plane commands per message + Lua (EVAL/EVALSHA) calls, from
  `CONFIG RESETSTAT` + `INFO commandstats`

`pnpm --filter @joaofnds/flume-bench bench:profile` runs the single-system event-loop /
Redis-CPU profiler instead.

## Saturation harness

```
pnpm --filter @joaofnds/flume-bench bench:sat
```

`benchmark/saturation.ts` answers a different question than the matrix above: **how far
can Flume push each backend, and who is the bottleneck at the ceiling?** A single Node
event loop tops out long before a multi-threaded server does, so this harness drives load
from **worker threads** (one producer or one consumer per thread), ramps the thread count
`1 → cores`, and at each step reports sustained throughput alongside **client CPU**
(`process.cpuUsage`, process-wide so it covers the workers) and **backend CPU**
(`docker stats` on the container). It sweeps two topologies per system:

- **independent** — each producer/consumer pair on its own topic/stream/group (spreads
  load across shards/cores).
- **shared** — all load on one topic + one competing group (single-stream contention).

The `bound by` column reads the knee: `backend cpu` (server near its core ceiling —
redis is one thread, nats many), `client cpu` (Node near the host's cores), or
`unsaturated` (neither — the limit is serialization/contention, e.g. NATS's single
catch-all stream). `SAT_FAST=1` runs a 2-step ramp for a quick check. Backends are
**redis** (6381) and **nats** (4223); BullMQ is dropped here — it's a comparative-matrix
baseline, not a saturation target.

A full run of both harnesses, plus a one-off Dragonfly-vs-Redis comparison and the NATS
adapter optimization that preceded this, is written up in [`REPORT.md`](./REPORT.md) — the
saturation sweep is expensive (it pins every core), so all numbers are captured there.

## The load-bearing result

The **ops table**, not the raw msg/s: Flume over Redis Streams at **~1.0 commands/msg
and 0.00 Lua/msg** vs BullMQ's **~32–37 commands/msg and ~2 EVAL/EVALSHA per msg** — the
no-Lua / portability thesis as a hard number. Throughput (≈1.4–7×) and latency wins are
the supporting act. Numbers vary run-to-run on a shared laptop; the direction is stable.

New adapters (e.g. `@joaofnds/flume-nats`) join the comparison by adding a `BenchSystem`
implementation in `benchmark/bench-systems.ts`.

## License

MIT
