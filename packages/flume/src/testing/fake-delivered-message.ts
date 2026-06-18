import { Topic } from "../domain/topic";
import { Bytes } from "../ports/codec";
import { DeliveredMessage } from "../ports/consumer";

export class FakeDeliveredMessage implements DeliveredMessage {
	acked = false;
	nacked = false;

	constructor(
		readonly topic: Topic,
		readonly id: string,
		readonly body: Bytes,
		readonly deliveryCount: number,
	) {}

	async ack(): Promise<void> {
		this.acked = true;
	}

	async nack(): Promise<void> {
		this.nacked = true;
	}
}
