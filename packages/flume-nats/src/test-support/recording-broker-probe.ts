import { BrokerProbe } from "../broker-probe";

export interface ConsumerStoppedCall {
	subject: string;
	durable: string;
	error: unknown;
}

export class RecordingBrokerProbe implements BrokerProbe {
	connectedCount = 0;
	disconnectedCount = 0;
	reconnectedCount = 0;
	readonly deliveryFailures: unknown[] = [];
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

	deliveryFailed(error: unknown): void {
		this.deliveryFailures.push(error);
	}

	consumerStopped(subject: string, durable: string, error: unknown): void {
		this.consumerStoppedCalls.push({ subject, durable, error });
	}
}
