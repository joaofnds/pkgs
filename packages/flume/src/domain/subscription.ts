import { DeliveryMode } from "./delivery-mode";
import { EventHandler } from "./event-handler";
import { RetryPolicy } from "./retry-policy";
import { Topic } from "./topic";

export type StartFrom = "new" | "beginning";

// `name` is the durable identity → consumer group → must be stable across deploys
// AND unique per topic. The Flume facade folds its namespace into this name, so
// the full durable identity {namespace}:{registeredName} lives here as one value.
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

	// Must collide exactly when two subs share {topic, name} (which would share one
	// consumer group and split work, breaking per-handler isolation) and only then.
	// JSON encoding keeps the join unambiguous for any name content.
	key(): string {
		return JSON.stringify([this.topic.name, this.name]);
	}
}
