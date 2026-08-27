import { BrokerProbe, ConsumerStop } from "./broker-probe";

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

	deliveryFailed(error: unknown): void {
		this.guard(() => this.delegate.deliveryFailed(error));
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
