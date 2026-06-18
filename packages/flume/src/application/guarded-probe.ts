import { Subscription } from "../domain/subscription";
import { Topic } from "../domain/topic";
import { DeliveredMessage } from "../ports/consumer";
import { Probe } from "../ports/probe";

export class GuardedProbe implements Probe {
	constructor(private readonly delegate: Probe) {}

	dispatched(topic: Topic): void {
		this.guard(() => this.delegate.dispatched(topic));
	}

	processed(sub: Subscription, msg: DeliveredMessage): void {
		this.guard(() => this.delegate.processed(sub, msg));
	}

	failed(sub: Subscription, msg: DeliveredMessage, error: unknown): void {
		this.guard(() => this.delegate.failed(sub, msg, error));
	}

	deadLettered(sub: Subscription, msg: DeliveredMessage): void {
		this.guard(() => this.delegate.deadLettered(sub, msg));
	}

	private guard(call: () => void): void {
		try {
			call();
		} catch {
			// swallow: a misbehaving probe must never break messaging
		}
	}
}
