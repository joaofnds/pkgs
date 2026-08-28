import { ConsoleProbeLogger, ProbeLogger } from "@joaofnds/flume";
import { BrokerProbe } from "./broker-probe";
import { RedriveResult } from "./redrive-result";

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

	reclaimed(count: number): void {
		this.logger.info("flume.broker.reclaimed", { count });
	}

	reclaimFailed(error: unknown): void {
		this.logger.error("flume.broker.reclaim_failed", {
			error: this.reason(error),
		});
	}

	reaped(groupsDestroyed: number, streamsTrimmed: number): void {
		this.logger.info("flume.broker.reaped", {
			groupsDestroyed,
			streamsTrimmed,
		});
	}

	reapFailed(error: unknown): void {
		this.logger.warn("flume.broker.reap_failed", {
			error: this.reason(error),
		});
	}

	heartbeatFailed(error: unknown): void {
		this.logger.warn("flume.broker.heartbeat_failed", {
			error: this.reason(error),
		});
	}

	redrove(result: RedriveResult): void {
		this.logger.info("flume.broker.redrove", {
			redriven: result.redriven,
			skipped: result.skipped,
		});
	}

	consumerStopped(stream: string, group: string, error: unknown): void {
		this.logger.error("flume.broker.consumer_stopped", {
			stream,
			group,
			error: this.reason(error),
		});
	}

	private reason(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
