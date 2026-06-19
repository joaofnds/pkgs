import { Bytes, DeliveredMessage, Topic } from "@joaofnds/flume";
import { JsMsg } from "nats";

export class NatsDeliveredMessage implements DeliveredMessage {
	readonly topic: Topic;
	readonly id: string;
	readonly body: Bytes;
	readonly deliveryCount: number;

	constructor(
		private readonly msg: JsMsg,
		topic: Topic,
	) {
		this.topic = topic;
		// The stream sequence is stable across redeliveries, so it is the message's
		// identity for the whole at-least-once lifecycle (dead-letter originalId).
		this.id = String(msg.seq);
		this.body = msg.data;
		// redeliveryCount is 1 on the first delivery, broker-tracked on every redelivery.
		this.deliveryCount = msg.info.redeliveryCount;
	}

	async ack(): Promise<void> {
		this.msg.ack();
	}

	async nack(): Promise<void> {
		await this.msg.nak();
	}
}
