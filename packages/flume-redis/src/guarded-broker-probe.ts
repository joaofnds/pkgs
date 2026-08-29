import { BrokerProbe } from "./broker-probe";
import { ConsumerStall } from "./consumer-stall";
import { ConsumerStop } from "./consumer-stop";
import { ReapResult } from "./reap-result";
import { RedriveResult } from "./redrive-result";

export class GuardedBrokerProbe implements BrokerProbe {
	constructor(private readonly delegate: BrokerProbe) {}

	connected(): void {
		this.guard(() => this.delegate.connected());
	}

	disconnected(): void {
		this.guard(() => this.delegate.disconnected());
	}

	reconnected(): void {
		this.guard(() => this.delegate.reconnected());
	}

	reclaimed(count: number): void {
		this.guard(() => this.delegate.reclaimed(count));
	}

	reclaimFailed(error: unknown): void {
		this.guard(() => this.delegate.reclaimFailed(error));
	}

	reaped(result: ReapResult): void {
		this.guard(() => this.delegate.reaped(result));
	}

	reapFailed(error: unknown): void {
		this.guard(() => this.delegate.reapFailed(error));
	}

	heartbeatFailed(error: unknown): void {
		this.guard(() => this.delegate.heartbeatFailed(error));
	}

	redrove(result: RedriveResult): void {
		this.guard(() => this.delegate.redrove(result));
	}

	consumerStalled(stall: ConsumerStall): void {
		this.guard(() => this.delegate.consumerStalled(stall));
	}

	consumerStopped(stop: ConsumerStop): void {
		this.guard(() => this.delegate.consumerStopped(stop));
	}

	private guard(call: () => void): void {
		try {
			call();
		} catch {
			// swallow: a misbehaving broker probe must never break messaging
		}
	}
}
