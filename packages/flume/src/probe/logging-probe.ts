import { Subscription } from "../domain/subscription";
import { Topic } from "../domain/topic";
import { DeliveredMessage } from "../ports/consumer";
import { Probe } from "../ports/probe";
import { ConsoleProbeLogger } from "./console-probe-logger";
import { ProbeLogger } from "./probe-logger";

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
