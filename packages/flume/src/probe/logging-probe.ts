import { Subscription, Topic } from "../domain";
import { DeliveredMessage, Probe } from "../ports";

// The sink a LoggingProbe writes to. An app injects its own structured logger
// (pino, winston, a metrics-emitting shim); the default writes JSON to the
// console. Kept tiny so it carries no dependency — Flume's core stays dep-free.
export interface ProbeLogger {
	info(event: string, fields: Record<string, unknown>): void;
	error(event: string, fields: Record<string, unknown>): void;
}

// Default sink: one JSON line per event on the matching console stream. Real
// deployments inject their own ProbeLogger; this keeps the out-of-the-box
// production impl useful and dependency-free.
export class ConsoleProbeLogger implements ProbeLogger {
	info(event: string, fields: Record<string, unknown>): void {
		console.info(JSON.stringify({ event, ...fields }));
	}

	error(event: string, fields: Record<string, unknown>): void {
		console.error(JSON.stringify({ event, ...fields }));
	}
}

// Production Probe: emits a structured log line per business event (the no-op
// FakeProbe stays the test default). Lifecycle events (dispatched, processed) log
// at info; failures and dead-letters at error. Guarding stays the core's job —
// Dispatcher/Worker wrap their probe in GuardedProbe — so this impl just logs.
export class LoggingProbe implements Probe {
	constructor(
		private readonly logger: ProbeLogger = new ConsoleProbeLogger(),
	) {}

	dispatched(topic: Topic): void {
		this.logger.info("flume.dispatched", { topic: topic.name });
	}

	processed(sub: Subscription, msg: DeliveredMessage): void {
		this.logger.info("flume.processed", this.context(sub, msg));
	}

	failed(sub: Subscription, msg: DeliveredMessage, error: unknown): void {
		this.logger.error("flume.failed", {
			...this.context(sub, msg),
			error: this.reason(error),
		});
	}

	deadLettered(sub: Subscription, msg: DeliveredMessage): void {
		this.logger.error("flume.dead_lettered", this.context(sub, msg));
	}

	private context(
		sub: Subscription,
		msg: DeliveredMessage,
	): Record<string, unknown> {
		return {
			subscription: sub.name,
			topic: msg.topic.name,
			id: msg.id,
			deliveryCount: msg.deliveryCount,
		};
	}

	private reason(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
