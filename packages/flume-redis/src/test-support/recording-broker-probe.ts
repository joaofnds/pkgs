import { BrokerProbe } from "../broker-probe";
import { ConsumerStall } from "../consumer-stall";
import { ConsumerStop } from "../consumer-stop";
import { ReapResult } from "../reap-result";
import { RedriveResult } from "../redrive-result";

export class RecordingBrokerProbe implements BrokerProbe {
	connectedCount = 0;
	disconnectedCount = 0;
	reconnectedCount = 0;
	readonly connectionAbandonedCalls: unknown[] = [];
	readonly reclaimedCounts: number[] = [];
	readonly reclaimFailures: unknown[] = [];
	readonly reapedCalls: ReapResult[] = [];
	readonly reapFailures: unknown[] = [];
	readonly heartbeatFailures: unknown[] = [];
	readonly redroveResults: RedriveResult[] = [];
	readonly consumerStalledCalls: ConsumerStall[] = [];
	readonly consumerStoppedCalls: ConsumerStop[] = [];

	connected(): void {
		this.connectedCount += 1;
	}

	disconnected(): void {
		this.disconnectedCount += 1;
	}

	reconnected(): void {
		this.reconnectedCount += 1;
	}

	connectionAbandoned(error: unknown): void {
		this.connectionAbandonedCalls.push(error);
	}

	reclaimed(count: number): void {
		this.reclaimedCounts.push(count);
	}

	reclaimFailed(error: unknown): void {
		this.reclaimFailures.push(error);
	}

	reaped(result: ReapResult): void {
		this.reapedCalls.push(result);
	}

	reapFailed(error: unknown): void {
		this.reapFailures.push(error);
	}

	heartbeatFailed(error: unknown): void {
		this.heartbeatFailures.push(error);
	}

	redrove(result: RedriveResult): void {
		this.redroveResults.push(result);
	}

	consumerStalled(stall: ConsumerStall): void {
		this.consumerStalledCalls.push(stall);
	}

	consumerStopped(stop: ConsumerStop): void {
		this.consumerStoppedCalls.push(stop);
	}
}
