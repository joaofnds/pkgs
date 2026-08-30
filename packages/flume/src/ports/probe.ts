import { Subscription } from "../domain/subscription";
import { Topic } from "../domain/topic";
import { DeliveredMessage } from "./consumer";
import { ProcessingTiming } from "./processing-timing";

export interface Probe {
	dispatched(topic: Topic): void;
	dispatchFailed(topic: Topic, error: unknown): void;
	processed(
		sub: Subscription,
		msg: DeliveredMessage,
		timing: ProcessingTiming,
	): void;
	failed(sub: Subscription, msg: DeliveredMessage, error: unknown): void;
	ackFailed(sub: Subscription, msg: DeliveredMessage, error: unknown): void;
	deadLettered(sub: Subscription, msg: DeliveredMessage): void;
}
