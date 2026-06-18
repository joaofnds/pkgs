import { Subscription, Topic } from "../domain";
import { DeliveredMessage, Probe } from "../ports";

// Decorator that makes the Probe port best-effort. It wraps every call so a
// throwing or buggy probe can never change messaging behavior — dispatch still
// resolves after a successful publish, and an ack/nack always completes. The
// core wraps its injected probe in this, so guarding holds even when a service
// is constructed directly in a test with a raw probe.
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
			// best-effort: observability must never break messaging.
		}
	}
}
