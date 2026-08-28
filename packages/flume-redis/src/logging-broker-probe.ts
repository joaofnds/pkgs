import { ConsoleProbeLogger, ProbeLogger } from "@joaofnds/flume";
import { BrokerProbe } from "./broker-probe";
import { ConsumerStop } from "./consumer-stop";
import { ReapResult } from "./reap-result";
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

	reaped(result: ReapResult): void {
		this.logger.info("flume.broker.reaped", {
			groupsDestroyed: result.groupsDestroyed,
			streamsTrimmed: result.streamsTrimmed,
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

	consumerStopped(stop: ConsumerStop): void {
		this.logger.error("flume.broker.consumer_stopped", {
			stream: stop.stream,
			group: stop.group,
			error: this.reason(stop.error),
		});
	}

	private reason(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
