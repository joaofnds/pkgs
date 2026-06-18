import { Subscription } from "../domain/subscription";
import { Topic } from "../domain/topic";
import { DeliveredMessage } from "./consumer";

export interface Probe {
	dispatched(topic: Topic): void;
	processed(sub: Subscription, msg: DeliveredMessage): void;
	failed(sub: Subscription, msg: DeliveredMessage, error: unknown): void;
	deadLettered(sub: Subscription, msg: DeliveredMessage): void;
}
