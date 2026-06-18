import { DeliveryMode } from "./delivery-mode";
import { EventHandler } from "./event-handler";
import { RetryPolicy } from "./retry-policy";
import { Topic } from "./topic";

export type StartFrom = "new" | "beginning";

export class Subscription {
	readonly topic: Topic;
	readonly name: string;
	readonly handler: EventHandler;
	readonly retry: RetryPolicy;
	readonly delivery: DeliveryMode;
	readonly startFrom: StartFrom;

	constructor(props: {
		topic: Topic;
		name: string;
		handler: EventHandler;
		retry: RetryPolicy;
		delivery: DeliveryMode;
		startFrom?: StartFrom;
	}) {
		this.topic = props.topic;
		this.name = props.name;
		this.handler = props.handler;
		this.retry = props.retry;
		this.delivery = props.delivery;
		this.startFrom = props.startFrom ?? "new";
	}

	key(): string {
		return JSON.stringify([this.topic.name, this.name]);
	}
}
