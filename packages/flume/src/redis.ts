// Redis Streams adapter entry — the ONLY path that pulls in `redis`. The core
// entry (./index) and everything under domain/ports/application/codec/clock never
// import anything here; this physical boundary is the precondition for later
// extracting @joaofnds/flume-redis without touching the core (PRD §13).
export * from "./adapters/redis";
