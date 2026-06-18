import { Subscription, Topic } from "../domain";
import { DeliveredMessage, Probe } from "../ports";

export interface ProcessedCall {
	sub: Subscription;
	msg: DeliveredMessage;
}

export interface FailedCall {
	sub: Subscription;
	msg: DeliveredMessage;
	error: unknown;
}

// Recording probe. Captures every call so tests can assert observability fired,
// in order, without a mocking framework.
export class FakeProbe implements Probe {
	readonly dispatchedTopics: Topic[] = [];
	readonly processedCalls: ProcessedCall[] = [];
	readonly failedCalls: FailedCall[] = [];
	readonly deadLetteredCalls: ProcessedCall[] = [];

	dispatched(topic: Topic): void {
		this.dispatchedTopics.push(topic);
	}

	processed(sub: Subscription, msg: DeliveredMessage): void {
		this.processedCalls.push({ sub, msg });
	}

	failed(sub: Subscription, msg: DeliveredMessage, error: unknown): void {
		this.failedCalls.push({ sub, msg, error });
	}

	deadLettered(sub: Subscription, msg: DeliveredMessage): void {
		this.deadLetteredCalls.push({ sub, msg });
	}
}
