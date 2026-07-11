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
	deliveryFailed(): void {
		throw new Error("broker probe boom");
	}
}
