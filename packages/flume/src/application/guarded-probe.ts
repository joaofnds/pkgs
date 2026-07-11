import { Subscription } from "../domain/subscription";
import { Topic } from "../domain/topic";
import { DeliveredMessage } from "../ports/consumer";
import { Probe } from "../ports/probe";
import { ProcessingTiming } from "../ports/processing-timing";

export class GuardedProbe implements Probe {
	constructor(private readonly delegate: Probe) {}

	dispatched(topic: Topic): void {
		this.guard(() => this.delegate.dispatched(topic));
	}

	dispatchFailed(topic: Topic, error: unknown): void {
		this.guard(() => this.delegate.dispatchFailed(topic, error));
	}

	processed(
		sub: Subscription,
		msg: DeliveredMessage,
		timing: ProcessingTiming,
	): void {
		this.guard(() => this.delegate.processed(sub, msg, timing));
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
