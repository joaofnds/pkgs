import { ConsoleProbeLogger, ProbeLogger } from "@joaofnds/flume";
import { BrokerProbe, ConsumerStop } from "./broker-probe";

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

	private reason(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
