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

## The load-bearing result

The **ops table**, not the raw msg/s: Flume over Redis Streams at **~1.0 commands/msg
and 0.00 Lua/msg** vs BullMQ's **~32–37 commands/msg and ~2 EVAL/EVALSHA per msg** — the
no-Lua / portability thesis as a hard number. Throughput (≈1.4–7×) and latency wins are
the supporting act. Numbers vary run-to-run on a shared laptop; the direction is stable.

New adapters (e.g. `@joaofnds/flume-nats`) join the comparison by adding a `BenchSystem`
implementation in `benchmark/bench-systems.ts`.

## License

MIT
