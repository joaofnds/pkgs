import { Subscription } from "../domain/subscription";
import { Topic } from "../domain/topic";
import { DeliveredMessage } from "./consumer";

// Observability port — real metrics/logs in prod, no-op/recording fake in tests.
// Best-effort and never load-bearing: implementations MUST NOT throw, and the
// core guards every call so a misbehaving probe can never make dispatch reject
// after a successful publish, nor block an ack/nack. Synchronous, no
// control-flow side-effects.
export interface Probe {
	dispatched(topic: Topic): void;
	processed(sub: Subscription, msg: DeliveredMessage): void;
	failed(sub: Subscription, msg: DeliveredMessage, error: unknown): void;
	deadLettered(sub: Subscription, msg: DeliveredMessage): void;
}
