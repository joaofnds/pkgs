import { BrokerProbe } from "../broker-probe";
import { RedriveResult } from "../redrive-result";

export interface ReapedCall {
	groupsDestroyed: number;
	streamsTrimmed: number;
}

export interface ConsumerStoppedCall {
	stream: string;
	group: string;
	error: unknown;
}

export class RecordingBrokerProbe implements BrokerProbe {
	connectedCount = 0;
	disconnectedCount = 0;
	reconnectedCount = 0;
	readonly reclaimedCounts: number[] = [];
	readonly reclaimFailures: unknown[] = [];
	readonly reapedCalls: ReapedCall[] = [];
	readonly reapFailures: unknown[] = [];
	readonly heartbeatFailures: unknown[] = [];
	readonly redroveResults: RedriveResult[] = [];
	readonly consumerStoppedCalls: ConsumerStoppedCall[] = [];

	connected(): void {
		this.connectedCount += 1;
	}

	disconnected(): void {
		this.disconnectedCount += 1;
	}

	reconnected(): void {
		this.reconnectedCount += 1;
	}

	reclaimed(count: number): void {
		this.reclaimedCounts.push(count);
	}

	reclaimFailed(error: unknown): void {
		this.reclaimFailures.push(error);
	}

	reaped(groupsDestroyed: number, streamsTrimmed: number): void {
		this.reapedCalls.push({ groupsDestroyed, streamsTrimmed });
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

	consumerStopped(stream: string, group: string, error: unknown): void {
		this.consumerStoppedCalls.push({ stream, group, error });
	}
}
