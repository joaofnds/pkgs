# Flume broker-adapter performance study

**Date:** 2026-06-19
**Author:** experiment run with Claude Code
**Scope:** (A) making the NATS JetStream adapter competitive with the Redis adapter,
(B) a one-off Dragonfly-vs-Redis comparison, (C) a multi-core saturation study that
ramps concurrent producers/consumers until each backend (or the client) is the bottleneck.

This document is the durable record of the experiment. The saturation sweep is expensive
to run (it saturates every core on the test machine), so **all measurements are captured
here** — re-running should not be necessary to recover any number below.

---

## Environment

| | |
|---|---|
| Machine | Apple M5 Pro, 18 cores, ~4.48 GHz |
| Runtime | Node 24.15.0 (arm64-darwin) |
| Redis | `redis:8-alpine`, port 6381 |
| Dragonfly | `docker.dragonflydb.io/dragonflydb/dragonfly:latest` (pulled 2026-06-19), port 6382 |
| NATS | `nats:2.10-alpine`, `-js` (file storage), port 4223 |
| NATS client | `nats@2.29.3` (the deprecated v2 client) |
| Redis client | `redis@6` (node-redis), RESP2-pinned by the adapter |

All backends ran as local Docker containers; the Node client ran on the host. Backend CPU
in the saturation study was sampled with `docker stats` (100% = one core). Client CPU was
`process.cpuUsage()` in the orchestrator, which is process-wide and therefore covers the
worker threads (verified: 4.02 cores reported for 4 busy workers).

---

## Part A — NATS adapter optimization

### Problem

The NATS JetStream adapter was **21.7× slower** than the Redis adapter on the comparative
benchmark (`throughput.bench.ts`, `BENCH_FAST` variant `1KB / 10k msgs / concurrency 200`):

| | flume-redis | bullmq | flume-nats | redis ÷ nats |
|---|---|---|---|---|
| msg/s | 188,080 | 22,179 | **8,673** | **21.69×** |
| latency p50 / p95 / p99 (ms) | 39.9 / 42.9 / 43.4 | 297.6 / 414.7 / 422.1 | **644.0 / 1086.1 / 1123.9** | |

### Root cause

The consume path was **fully sequential** (`for await (msg) { await deliver(msg) }`) and
each ack was a **server-confirmed `ackAck()` round-trip**. Serialized round-trips were the
entire gap. The core `Worker` only *fires* `msg.ack()` — it never reads the confirmation —
so the confirmation was pure overhead.

### The three levers (each measured in isolation)

Same `1KB / 10k / c200` variant, applied cumulatively:

| Change | nats msg/s | redis ÷ nats | nats p50 (ms) |
|---|---|---|---|
| baseline (`ackAck`, sequential) | 8,673 | 21.69× | 644.0 |
| **1. fire-and-forget `msg.ack()`** | 48,974 | 3.85× | 172.0 |
| **2. + bounded-concurrency drain** (`readCount`) | 49,628 | 3.85× | 173.2 |
| **3. + `noAsyncTraces: true`** (connection default) | 74,691 | 2.64× | 105.1 |

1. **Fire-and-forget ack.** `msg.ack()` publishes `+ACK` to the reply subject and returns
   immediately (no round-trip); the client batches it into the next TCP flush. At-least-once
   is preserved — a lost ack just redelivers after `ack_wait`, the path the Worker already
   handles. This is the single biggest win (21.7× → 3.85×).

2. **Bounded-concurrency drain.** The drain now dispatches up to `readCount` deliveries
   concurrently (a `Promise.race` pool), mirroring the Redis adapter's "`readCount` is the
   concurrency knob." **No change in the no-op benchmark** (it is publish/ack-bound) but a
   **~100× win for real I/O handlers** — see the slow-handler probe below.

3. **`noAsyncTraces: true`.** The v2 client captures a `new Error()` stack per request for
   async traces. Disabling it (overridable via the user's `nats` options) **doubled
   confirmed publish** without touching durability (`js.publish` keeps its PubAck).

### Diagnostic micro-benchmarks (why, not just what)

Isolating publish vs consume, file vs memory storage (N = 20,000, 1KB):

| path | file storage | memory storage |
|---|---|---|
| `js.publish` (confirmed PubAck) | 67,760 /s | 71,747 /s |
| `js.publish` **with `noAsyncTraces`** | 138,360 /s | 140,060 /s |
| core `nc.publish` fire+flush (no confirm) | 844,355 /s | 685,061 /s |
| consume (fire-and-forget ack) | 165,583 /s | 186,238 /s |

Findings:
- **Storage type barely matters** (67k file vs 71k mem) — the publish ceiling is **not**
  fsync/durability. The same stream absorbs 844k/s via fire-and-forget, so the **server**
  is not the limit either.
- The limit was the **client-side PubAck request machinery**; the per-request stack capture
  (`noAsyncTraces`) was half of it.
- **Consume is already fast** (~165k/s) — it was never the bottleneck after the ack fix.

Connection topology (combined publish+consume, N = 10,000):

| | run 1 | run 2 |
|---|---|---|
| one shared connection | 80,811 /s | 79,662 /s |
| dedicated publish connection | 80,680 /s | 82,471 /s |

A separate publish connection makes **no difference** — the combined ceiling (~80k single
process) is the v2 client's single-event-loop per-message CPU, not connection contention.

Slow-handler concurrency probe (5 ms handler, 2,000 msgs, through the real broker):

| readCount | throughput |
|---|---|
| 1 (serial) | 158 /s |
| 50 | 7,700 /s |
| 200 | 15,806 /s |

Throughput scales linearly with `readCount` — the concurrency change is a ~100× win for
real handlers even though the no-op matrix can't show it.

### Full comparative matrix (after optimization)

`throughput.bench.ts`, competing mode, full sweep. `flume` = flume-redis.

#### Throughput (msg/s; ratios are flume ÷ X)

| payload/count/conc | flume | bullmq | nats | flume÷bullmq | flume÷nats |
|---|---|---|---|---|---|
| 64B/1k/c50   | 38,613 | 23,333 | 30,449 | 1.65× | 1.27× |
| 64B/1k/c200  | 49,891 | 18,300 | 33,409 | 2.73× | 1.49× |
| 64B/1k/c500  | 47,286 | 11,331 | 34,306 | 4.17× | 1.38× |
| 64B/10k/c50  | 37,140 | 23,681 | 33,434 | 1.57× | 1.11× |
| 64B/10k/c200 | 48,101 | 30,759 | 35,981 | 1.56× | 1.34× |
| 64B/10k/c500 | 38,921 | 24,329 | 36,800 | 1.60× | 1.06× |
| 1KB/1k/c50   | 36,507 | 20,586 | 28,281 | 1.77× | 1.29× |
| 1KB/1k/c200  | 42,321 | 16,245 | 29,699 | 2.61× | 1.43× |
| 1KB/1k/c500  | 39,989 | 11,444 | 31,212 | 3.49× | 1.28× |
| 1KB/10k/c50  | 39,291 | 22,133 | 32,477 | 1.78× | 1.21× |
| 1KB/10k/c200 | 45,036 | 22,711 | 30,527 | 1.98× | 1.48× |
| 1KB/10k/c500 | 32,505 | 21,401 | 35,301 | 1.52× | **0.92×** |
| 16KB/1k/c50  | 40,804 | 8,421 | 27,013 | 4.85× | 1.51× |
| 16KB/1k/c200 | 46,732 | 7,583 | 28,588 | 6.16× | 1.63× |
| 16KB/1k/c500 | 44,760 | 6,319 | 27,997 | 7.08× | 1.60× |
| 16KB/10k/c50 | 41,623 | 8,457 | 31,109 | 4.92× | 1.34× |
| 16KB/10k/c200| 44,953 | 8,211 | 34,448 | 5.47× | 1.30× |
| 16KB/10k/c500| 45,479 | 8,091 | 34,463 | 5.62× | 1.32× |

NATS is **~1.0–1.6× of Redis** across the matrix (and *beats* it at 1KB/10k/c500), down
from a uniform 21.7×.

#### Latency (dispatch→process under burst, ms; f=flume, b=bullmq, n=nats)

| payload/count/conc | f p50/p95/p99 | b p50/p95/p99 | n p50/p95/p99 |
|---|---|---|---|
| 64B/1k/c50   | 4.0 / 5.6 / 5.8     | 30.3 / 42.4 / 43.5    | 10.2 / 13.6 / 13.9 |
| 64B/1k/c200  | 2.6 / 3.2 / 3.3     | 42.4 / 54.6 / 55.0    | 9.2 / 11.5 / 11.7 |
| 64B/1k/c500  | 2.5 / 2.9 / 2.9     | 72.1 / 81.3 / 81.7    | 9.3 / 11.8 / 11.9 |
| 64B/10k/c50  | 47.4 / 71.0 / 72.5  | 355.2 / 484.4 / 493.1 | 103.2 / 137.5 / 140.4 |
| 64B/10k/c200 | 30.9 / 38.7 / 39.3  | 264.3 / 340.5 / 347.1 | 99.7 / 125.1 / 127.3 |
| 64B/10k/c500 | 39.6 / 44.0 / 44.2  | 273.5 / 367.5 / 376.2 | 110.7 / 140.5 / 142.8 |
| 1KB/1k/c50   | 7.4 / 9.1 / 9.3     | 34.3 / 48.0 / 49.2    | 11.9 / 15.4 / 15.8 |
| 1KB/1k/c200  | 3.5 / 4.1 / 4.1     | 49.2 / 62.1 / 63.1    | 10.9 / 14.5 / 14.8 |
| 1KB/1k/c500  | 3.3 / 3.7 / 3.7     | 73.6 / 85.9 / 86.4    | 11.3 / 14.2 / 14.5 |
| 1KB/10k/c50  | 45.7 / 61.8 / 63.2  | 266.6 / 430.2 / 440.8 | 114.0 / 147.4 / 150.2 |
| 1KB/10k/c200 | 37.9 / 44.8 / 45.4  | 250.9 / 356.4 / 363.8 | 123.2 / 153.5 / 156.1 |
| 1KB/10k/c500 | 36.8 / 41.9 / 42.2  | 318.9 / 407.1 / 415.0 | 105.3 / 130.1 / 134.6 |
| 16KB/1k/c50  | 18.3 / 24.6 / 25.0  | 84.8 / 113.5 / 114.9  | 24.2 / 29.4 / 29.9 |
| 16KB/1k/c200 | 18.2 / 22.6 / 22.7  | 100.8 / 123.2 / 124.2 | 20.8 / 24.1 / 24.4 |
| 16KB/1k/c500 | 18.8 / 21.7 / 21.8  | 116.6 / 148.0 / 148.9 | 19.4 / 25.2 / 25.5 |
| 16KB/10k/c50 | 185.2 / 203.6 / 207.2 | 705.2 / 1089.3 / 1115.8 | 216.2 / 274.9 / 280.8 |
| 16KB/10k/c200| 185.8 / 195.9 / 197.4 | 734.0 / 1080.7 / 1103.4 | 208.9 / 254.1 / 260.4 |
| 16KB/10k/c500| 170.8 / 184.3 / 185.6 | 736.7 / 1058.7 / 1071.4 | 416.6 / 463.0 / 467.9 |

NATS p50 collapsed from **644 ms (baseline) to single/low-double digits** at small batches.
The one outlier is 16KB/10k/c500 (p99 468 ms) — large payload + high concurrency + high
count, the worst-case corner.

#### Redis ops (data-plane commands per message; Lua = EVAL/EVALSHA/FCALL)

Flume holds **~1.00–1.04 cmds/msg and 0.00 Lua/msg** across every variant; BullMQ runs
**~32–42 cmds/msg and ~2.0–2.75 Lua/msg**. This is the load-bearing "no-Lua" result; it is
a Redis-server metric, so NATS has no entry. (NATS has no equivalent EVAL cost — it is a
different protocol entirely.)

#### Broadcast (flume only; BullMQ has no native broadcast)

| variant | msg/s | p99 (ms) | cmds/msg |
|---|---|---|---|
| 64B/10k/c200 competing | 45,195 | 38.9 | 1.01 |
| 64B/10k/c200 broadcast | 47,074 | 38.1 | 1.01 |
| 1KB/10k/c200 competing | 46,146 | 40.3 | 1.01 |
| 1KB/10k/c200 broadcast | 46,124 | 47.1 | 1.01 |
| 16KB/10k/c200 competing | 40,744 | 220.4 | 1.01 |
| 16KB/10k/c200 broadcast | 45,605 | 195.9 | 1.01 |

#### Headline (mitata, 1KB/10k/c200)

flume **218.95 ms/iter** vs bullmq **445.37 ms/iter** → flume **2.03× faster than BullMQ**.

### Residual gap

NATS remains ~1.0–1.6× behind Redis because the **v2 JetStream client's per-message CPU**
(PUB/PubAck/JsMsg machinery) is heavier than Redis's leaner RESP + stream ops, on a single
event loop. It is not fsync, not connection multiplexing. The v3 `@nats-io/*` client is a
tracked migration that may narrow this further.

---

## Part B — Dragonfly vs Redis (one-off)

**Question:** would swapping Redis for [Dragonfly](https://www.dragonflydb.io/) (a
multi-threaded, Redis-API-compatible server) make flume-redis faster?

**Method:** the same `FlumeSystem` (the unmodified Redis adapter), same single-stream
`1KB / 10k / c200` workload, 6 samples after warmup, p50:

| backend | throughput | p50 | samples (ms) |
|---|---|---|---|
| Redis 8 | **190,780 /s** | 52 ms | 49, 50, 52, 52, 56, 64 |
| Dragonfly | 184,773 /s | 54 ms | 51, 53, 53, 54, 60, 63 |

**Result: ~3% apart — within run-to-run noise. No win.** A single stream key lives on a
single Dragonfly shard, so its multi-threading has nothing to parallelize; the ceiling is
the node client's single event loop (the ops table already showed ~1.0 cmd/msg — almost
nothing left for a faster server to shave). Dragonfly would only pull ahead in a
**many-stream fan-out** that spreads keys across shards (confirmed in Part C: Dragonfly
*independent* topology scales to ~1.1M, *shared* topology does not).

Caveats found: the hot path (`XADD`/`XGROUP CREATE`/`XREADGROUP`/`XACK`/`XTRIM`) ran
correctly on Dragonfly, but the reclaim/reaper/redrive commands (`XAUTOCLAIM`,
`XINFO GROUPS`, `XPENDING` — the RESP2-quirk-sensitive ones the adapter depends on) were
**not** exercised; those are historically where Dragonfly's Streams lagged and would need a
conformance run before adoption. `INFO commandstats` / `CONFIG RESETSTAT` also differ, so
the no-Lua ops table would not render against Dragonfly.

**Decision:** Dragonfly is **not** kept as a continuously-tested backend. This study is its
only record; the harness and compose file track only Redis and NATS.

---

## Part C — Multi-core saturation study

### Goal

Push Flume with many concurrent producers and consumers until **the backend (or the
client) is the bottleneck**, and prove *which*. A single Node event loop saturates one core
(~190k/s Redis, ~80k/s NATS) long before a multi-threaded server does, so load is driven
from **worker threads**.

### Method

- **Worker threads**: one producer *or* one consumer per thread; the harness ramps the
  thread count `1 → 18` (host cores). Total in-process concurrency at step `W` is
  `W × readCount` consume slots and `W × pubInflight` publish slots.
- **Two topologies per system**:
  - *independent* — each producer/consumer pair on its own topic/stream/group (spreads load
    across shards/cores).
  - *shared* — all load on one topic + one competing group (single-stream contention).
- **Consumers spawn before producers** so `startFrom:new` misses nothing.
- **Backlog throttle**: producers publish flat-out within a bounded in-flight window; the
  orchestrator pauses/resumes them as `published − processed` crosses 400k / 150k. This
  bounds memory while keeping the measured rate backend-limited, not buffer-limited.
- **Steady state**: 3 s warmup, 5 s measurement window; throughput = Δprocessed / Δt.
- **CPU attribution**: client via `process.cpuUsage()`; backend via `docker stats`. The
  `bound by` label compares each side to *its* ceiling — Redis executes commands on one
  thread (ceiling = 1 core), Dragonfly/NATS are multi-threaded (ceiling = host cores) — and
  reports `backend cpu` / `client cpu` / `unsaturated` (neither ≥70%, so the limit is
  serialization/contention, not CPU). Payload 64 B.

### Results (Apple M5 Pro, 18 cores, 64 B)

#### Redis

| topology | W | msg/s | client cores | backend cores | bound by |
|---|---|---|---|---|---|
| independent | 1  | 409,973 | 1.70 | 0.48 | unsaturated |
| independent | 2  | 593,011 | 2.73 | 0.77 | backend cpu |
| independent | 4  | 628,366 | 3.10 | 0.81 | backend cpu |
| independent | 8  | 678,466 | 3.59 | 0.78 | backend cpu |
| independent | 12 | 643,279 | 4.12 | 0.79 | backend cpu |
| independent | 18 | **687,782** | 4.57 | 0.84 | backend cpu |
| shared | 1  | 399,411 | 1.74 | 0.49 | unsaturated |
| shared | 2  | 564,415 | 2.75 | 0.79 | backend cpu |
| shared | 4  | 593,101 | 2.82 | 0.80 | backend cpu |
| shared | 8  | 584,439 | 3.54 | 0.79 | backend cpu |
| shared | 12 | **627,226** | 4.15 | 0.87 | backend cpu |
| shared | 18 | 607,142 | 4.18 | 0.82 | backend cpu |

**Redis is backend-bound at ~600–690k.** Its single command thread saturates at W≥2
(~0.8 core); adding workers raises client CPU but not throughput. Topology is irrelevant
(one thread serves all streams either way).

#### Dragonfly (one-off; not retained in the repo)

| topology | W | msg/s | client cores | backend cores | bound by |
|---|---|---|---|---|---|
| independent | 1  | 388,889 | 1.79 | 0.71 | unsaturated |
| independent | 2  | 634,385 | 3.43 | 1.27 | unsaturated |
| independent | 4  | 903,529 | 6.08 | 2.42 | unsaturated |
| independent | 8  | 1,052,241 | 7.82 | 3.16 | unsaturated |
| independent | 12 | 1,078,623 | 8.70 | 3.21 | unsaturated |
| independent | 18 | **1,121,903** | 8.83 | 3.45 | unsaturated |
| shared | 1  | 387,310 | 1.82 | 0.70 | unsaturated |
| shared | 2  | 568,575 | 2.99 | 1.22 | unsaturated |
| shared | 4  | 676,957 | 4.46 | 1.67 | unsaturated |
| shared | 8  | 680,396 | 4.13 | 1.69 | unsaturated |
| shared | 12 | **770,722** | 5.06 | 1.85 | unsaturated |
| shared | 18 | 254,107 | 3.51 | 1.77 | unsaturated |

**Dragonfly independent scales past 1.1M** and never CPU-saturates within 18 cores — its
multi-threading spreads independent streams across shards (~1.6× Redis's ceiling). The
**shared** topology tops out ~770k and then **collapses to 254k at W=18** — single-stream
contention (18 competing consumers on one stream + backlog-throttle thrash). This mirrors
Part B: Dragonfly only wins when work is spread across many streams.

#### NATS

| topology | W | msg/s | client cores | backend cores | bound by |
|---|---|---|---|---|---|
| independent | 1  | 109,296 | 1.80 | 0.81 | unsaturated |
| independent | 2  | 134,241 | 3.29 | 1.34 | unsaturated |
| independent | 4  | **142,089** | 4.01 | 1.54 | unsaturated |
| independent | 8  | 138,901 | 4.85 | 1.61 | unsaturated |
| independent | 12 | 140,874 | 5.24 | 1.62 | unsaturated |
| shared | 1  | 120,048 | 1.93 | 0.82 | unsaturated |
| shared | 2  | 129,446 | 3.18 | 1.30 | unsaturated |
| shared | 4  | **137,154** | 3.96 | 1.46 | unsaturated |
| shared | 8  | 121,717 | 4.79 | 1.64 | unsaturated |
| shared | 12 | 96,476 | 5.38 | 1.50 | unsaturated |

**NATS plateaus ~140k and is `unsaturated`** — neither client (~27% of cores) nor server
(~9%) is CPU-bound. The bottleneck is the **single catch-all `flume` stream**: JetStream
assigns sequence numbers serially per stream, so all topics funnel through one sequencer.
The shared topology is slightly worse and degrades at high W (the single durable's
`max_ack_pending` default of 1000 caps in-flight across all bound consumers). **Sharding
into multiple streams is the lever** to raise the NATS ceiling — not more cores.

### Peak summary

| system | topology | peak msg/s | @W | bound by |
|---|---|---|---|---|
| redis | independent | 687,782 | 18 | backend cpu |
| redis | shared | 627,226 | 12 | backend cpu |
| dragonfly | independent | 1,121,903 | 18 | unsaturated (client-led) |
| dragonfly | shared | 770,722 | 12 | unsaturated |
| nats | independent | 142,089 | 4 | unsaturated (single-stream) |
| nats | shared | 137,154 | 4 | unsaturated (single-stream) |

---

## Conclusions

1. **The NATS adapter is now production-competitive** — ~1.0–1.6× of Redis (occasionally
   faster), down from 21.7×, with no loss of at-least-once guarantees. Three changes:
   fire-and-forget acks, a concurrent drain, and `noAsyncTraces`.
2. **Redis is single-thread-bound** at ~600–690k msg/s for this workload; no client
   parallelism raises it (and Dragonfly only helps with many independent streams).
3. **Dragonfly is not worth maintaining** as a second Redis-compatible backend: it ties
   Redis on a single stream and only wins on many-stream fan-out, a topology the production
   adapter does not use. Recorded here; removed from the repo.
4. **NATS's ceiling (~140k) is architectural, not CPU**: the one catch-all stream
   serializes. If higher NATS throughput is ever needed, shard topics across multiple
   JetStream streams.

## Follow-ups (not done)

- **NATS concurrent-create race**: many workers calling `ensureStream`/`ensureConsumer` at
  once race (concurrent `streams.add`/`consumers.add` throw). The saturation harness works
  around it by pre-creating infra; the adapter itself should make creation idempotent.
- **v3 NATS client** (`@nats-io/*`) migration may narrow the residual per-message CPU gap.
- **Saturation harness is 64 B only**; a payload knob would show where large payloads move
  the knee.
- **Dragonfly/shared W=18 collapse** (254k) deserves a closer look (hysteresis thrash vs
  genuine contention collapse) if Dragonfly is ever revisited.

## Reproduction

```
# comparative matrix (Redis vs NATS vs BullMQ)
pnpm --filter @joaofnds/flume-bench bench          # full; BENCH_FAST=1 for one variant

# saturation sweep (Redis, NATS)
pnpm --filter @joaofnds/flume-bench bench:sat       # full; SAT_FAST=1 for a 2-step ramp
```

Knobs live at the top of `benchmark/saturation.ts` (`RAMP`, `PAYLOAD`, `READ_COUNT`,
`PUB_INFLIGHT`, `WARMUP_MS`, `MEASURE_MS`, `BACKLOG_HIGH/LOW`). The Dragonfly numbers above
were produced by adding a `dragonfly` service to `compose.yaml` and a `dragonfly` entry to
the harness's `SYSTEMS`; both were removed after this study.
