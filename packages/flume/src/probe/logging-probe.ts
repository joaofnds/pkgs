import { Subscription } from "../domain/subscription";
import { Topic } from "../domain/topic";
import { DeliveredMessage } from "../ports/consumer";
import { Probe } from "../ports/probe";
import { ProcessingTiming } from "../ports/processing-timing";
import { ConsoleProbeLogger } from "./console-probe-logger";
import { ProbeLogger } from "./probe-logger";

export class LoggingProbe implements Probe {
	constructor(
		private readonly logger: ProbeLogger = new ConsoleProbeLogger(),
	) {}

	dispatched(topic: Topic): void {
		this.logger.info("flume.dispatched", { topic: topic.name });
	}

	dispatchFailed(topic: Topic, error: unknown): void {
		this.logger.error("flume.dispatch_failed", {
			topic: topic.name,
			error: this.reason(error),
		});
	}

	processed(
		sub: Subscription,
		msg: DeliveredMessage,
		timing: ProcessingTiming,
	): void {
		this.logger.info("flume.processed", {
			...this.context(sub, msg),
			handlerDurationMs: timing.handlerDurationMs,
			endToEndLatencyMs: timing.endToEndLatencyMs,
		});
	}

	failed(sub: Subscription, msg: DeliveredMessage, error: unknown): void {
		this.logger.warn("flume.failed", {
			...this.context(sub, msg),
			error: this.reason(error),
		});
	}

	ackFailed(sub: Subscription, msg: DeliveredMessage, error: unknown): void {
		this.logger.warn("flume.ack_failed", {
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
