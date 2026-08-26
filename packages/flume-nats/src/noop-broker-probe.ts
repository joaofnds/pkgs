import { BrokerProbe } from "./broker-probe";

export class NoopBrokerProbe implements BrokerProbe {
	connected(): void {}
	disconnected(): void {}
	reconnected(): void {}
	deliveryFailed(): void {}
	consumerStopped(): void {}
}
