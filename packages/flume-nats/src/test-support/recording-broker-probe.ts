import { BrokerProbe, ConsumerStop } from "../broker-probe";

export class RecordingBrokerProbe implements BrokerProbe {
	connectedCount = 0;
	disconnectedCount = 0;
	reconnectedCount = 0;
	readonly deliveryFailures: unknown[] = [];
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

	deliveryFailed(error: unknown): void {
		this.deliveryFailures.push(error);
	}

	consumerStopped(stop: ConsumerStop): void {
		this.consumerStoppedCalls.push(stop);
	}
}
