import { BrokerProbe } from "../broker-probe";

export class ThrowingBrokerProbe implements BrokerProbe {
	connected(): void {
		throw new Error("broker probe boom");
	}
	disconnected(): void {
		throw new Error("broker probe boom");
	}
	reconnected(): void {
		throw new Error("broker probe boom");
	}
	connectionAbandoned(): void {
		throw new Error("broker probe boom");
	}
	reclaimed(): void {
		throw new Error("broker probe boom");
	}
	reclaimFailed(): void {
		throw new Error("broker probe boom");
	}
	reaped(): void {
		throw new Error("broker probe boom");
	}
	reapFailed(): void {
		throw new Error("broker probe boom");
	}
	heartbeatFailed(): void {
		throw new Error("broker probe boom");
	}
	redrove(): void {
		throw new Error("broker probe boom");
	}
	consumerStalled(): void {
		throw new Error("broker probe boom");
	}
	consumerStopped(): void {
		throw new Error("broker probe boom");
	}
}
