import {
	BrokerProbe,
	ConsumerDegradation,
	ConsumerStall,
	ConsumerStop,
} from "../broker-probe";

export class RecordingBrokerProbe implements BrokerProbe {
	connectedCount = 0;
	disconnectedCount = 0;
	reconnectedCount = 0;
	readonly deliveryFailures: unknown[] = [];
	readonly consumerStoppedCalls: ConsumerStop[] = [];
	readonly consumerStalledCalls: ConsumerStall[] = [];
	readonly consumerDegradedCalls: ConsumerDegradation[] = [];

	connected(): void {
		this.connectedCount += 1;
	}

	disconnected(): void {
		this.disconnectedCount += 1;
	}

	reconnected(): void {
		this.reconnectedCount += 1;
	}

	deliveryFailed(error: unknown): void {
		this.deliveryFailures.push(error);
	}

	consumerStopped(stop: ConsumerStop): void {
		this.consumerStoppedCalls.push(stop);
	}

	consumerStalled(stall: ConsumerStall): void {
		this.consumerStalledCalls.push(stall);
	}

	consumerDegraded(degradation: ConsumerDegradation): void {
		this.consumerDegradedCalls.push(degradation);
	}
}
