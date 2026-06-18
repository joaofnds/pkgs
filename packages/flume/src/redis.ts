// Redis Streams adapter entry — the ONLY path that pulls in `redis`. The core
// entry (./index) and everything under domain/ports/application/codec/clock/probe
// never import anything here; this physical boundary is the precondition for later
// extracting @joaofnds/flume-redis without touching the core (PRD §13).
export * from "./adapters/redis/broker-closed-error";
export * from "./adapters/redis/broker-error";
export * from "./adapters/redis/broker-not-connected-error";
export * from "./adapters/redis/delivered-message";
export * from "./adapters/redis/errors";
export * from "./adapters/redis/options";
export * from "./adapters/redis/redis-streams-broker";
export * from "./adapters/redis/redrive-result";
