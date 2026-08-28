import { ConsumerStop } from "./consumer-stop";
import { ReapResult } from "./reap-result";
import { RedriveResult } from "./redrive-result";

export interface BrokerProbe {
	connected(): void;
	disconnected(): void;
	reconnected(): void;
	reclaimed(count: number): void;
	reclaimFailed(error: unknown): void;
	reaped(result: ReapResult): void;
	reapFailed(error: unknown): void;
	heartbeatFailed(error: unknown): void;
	redrove(result: RedriveResult): void;
	consumerStopped(stop: ConsumerStop): void;
}
