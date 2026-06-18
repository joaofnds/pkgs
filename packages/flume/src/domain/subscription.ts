import { DeliveryMode } from "./delivery-mode";
import { EventHandler } from "./event-handler";
import { RetryPolicy } from "./retry-policy";
import { Topic } from "./topic";

export type StartFrom = "new" | "beginning";

// The binding of {topic, handler, name, retry, delivery}. `name` is the durable
// identity → consumer group → must be stable across deploys AND unique per topic.
// The Flume facade folds its namespace into this name (see Flume), so the full
// durable identity {namespace}:{registeredName} lives here as one value.
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

	// Stable identity for duplicate detection and consumer routing. Two subs that
	// share {topic, name} would share one consumer group and split work, silently
	// breaking per-handler isolation — so this key must collide exactly then, and
	// only then. JSON encoding keeps the join unambiguous for any name content.
	key(): string {
		return JSON.stringify([this.topic.name, this.name]);
	}
}
