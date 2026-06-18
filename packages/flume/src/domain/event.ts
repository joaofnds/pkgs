import { Topic } from "./topic";

// A domain occurrence handed to a handler. `payload` is codec-decoded;
// `id`/`deliveryCount` come from the broker; `dispatchedAt` from the envelope.
export class Event<T = unknown> {
	readonly topic: Topic;
	readonly payload: T;
	readonly id: string;
	readonly deliveryCount: number;
	readonly dispatchedAt: Date;

	constructor(props: {
		topic: Topic;
		payload: T;
		id: string;
		deliveryCount: number;
		dispatchedAt: Date;
	}) {
		this.topic = props.topic;
		this.payload = props.payload;
		this.id = props.id;
		this.deliveryCount = props.deliveryCount;
		this.dispatchedAt = props.dispatchedAt;
	}
}
