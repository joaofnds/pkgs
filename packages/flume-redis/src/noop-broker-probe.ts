import { BrokerProbe } from "./broker-probe";

export class NoopBrokerProbe implements BrokerProbe {
	connected(): void {}
	disconnected(): void {}
	reconnected(): void {}
	reclaimed(): void {}
	reclaimFailed(): void {}
	reaped(): void {}
	reapFailed(): void {}
	heartbeatFailed(): void {}
	redrove(): void {}
	consumerStalled(): void {}
	consumerStopped(): void {}
}
