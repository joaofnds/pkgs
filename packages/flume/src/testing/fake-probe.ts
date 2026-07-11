import { Subscription } from "../domain/subscription";
import { Topic } from "../domain/topic";
import { DeliveredMessage } from "../ports/consumer";
import { Probe } from "../ports/probe";
import { ProcessingTiming } from "../ports/processing-timing";

export interface ProcessedCall {
	sub: Subscription;
	msg: DeliveredMessage;
	timing: ProcessingTiming;
}

export interface FailedCall {
	sub: Subscription;
	msg: DeliveredMessage;
	error: unknown;
}

export interface DispatchFailedCall {
	topic: Topic;
	error: unknown;
}

export interface DeadLetteredCall {
	sub: Subscription;
	msg: DeliveredMessage;
}

export class FakeProbe implements Probe {
	readonly dispatchedTopics: Topic[] = [];
	readonly dispatchFailedCalls: DispatchFailedCall[] = [];
	readonly processedCalls: ProcessedCall[] = [];
	readonly failedCalls: FailedCall[] = [];
	readonly deadLetteredCalls: DeadLetteredCall[] = [];

	dispatched(topic: Topic): void {
		this.dispatchedTopics.push(topic);
	}

	dispatchFailed(topic: Topic, error: unknown): void {
		this.dispatchFailedCalls.push({ topic, error });
	}

	processed(
		sub: Subscription,
		msg: DeliveredMessage,
		timing: ProcessingTiming,
	): void {
		this.processedCalls.push({ sub, msg, timing });
	}

	failed(sub: Subscription, msg: DeliveredMessage, error: unknown): void {
		this.failedCalls.push({ sub, msg, error });
	}

	deadLettered(sub: Subscription, msg: DeliveredMessage): void {
		this.deadLetteredCalls.push({ sub, msg });
	}
}
