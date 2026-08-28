import { ConsoleProbeLogger, ProbeLogger } from "@joaofnds/flume";
import {
	BrokerProbe,
	ConsumerDegradation,
	ConsumerStall,
	ConsumerStop,
} from "./broker-probe";

export class LoggingBrokerProbe implements BrokerProbe {
	constructor(
		private readonly logger: ProbeLogger = new ConsoleProbeLogger(),
	) {}

	connected(): void {
		this.logger.info("flume.broker.connected", {});
	}

	disconnected(): void {
		this.logger.error("flume.broker.disconnected", {});
	}

	reconnected(): void {
		this.logger.info("flume.broker.reconnected", {});
	}

	deliveryFailed(error: unknown): void {
		this.logger.error("flume.broker.delivery_failed", {
			error: this.reason(error),
		});
	}

	consumerStopped(stop: ConsumerStop): void {
		this.logger.error("flume.broker.consumer_stopped", {
			subject: stop.subject,
			durable: stop.durable,
			error: this.reason(stop.error),
		});
	}

	consumerStalled(stall: ConsumerStall): void {
		this.logger.error("flume.broker.consumer_stalled", {
			subject: stall.subject,
			durable: stall.durable,
			reason: stall.reason,
			occurrences: stall.occurrences,
			consecutive: stall.consecutive,
		});
	}

	consumerDegraded(degradation: ConsumerDegradation): void {
		const level =
			degradation.reason === "status_watch_failed" ? "error" : "warn";

		this.logger[level]("flume.broker.consumer_degraded", {
			subject: degradation.subject,
			durable: degradation.durable,
			reason: degradation.reason,
			occurrences: degradation.occurrences,
		});
	}

	private reason(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
