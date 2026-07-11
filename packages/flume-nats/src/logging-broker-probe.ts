import { ConsoleProbeLogger, ProbeLogger } from "@joaofnds/flume";
import { BrokerProbe } from "./broker-probe";

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

	private reason(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
