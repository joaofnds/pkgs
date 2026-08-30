import { Topic } from "../domain/topic";
import { Bytes } from "../ports/codec";
import { DeliveredMessage } from "../ports/consumer";

export class FakeDeliveredMessage implements DeliveredMessage {
	acked = false;
	nacked = false;
	private ackError: unknown;

	constructor(
		readonly topic: Topic,
		readonly id: string,
		readonly body: Bytes,
		readonly deliveryCount: number,
	) {}

	failAckWith(error: unknown): void {
		this.ackError = error;
	}

	async ack(): Promise<void> {
		if (this.ackError !== undefined) {
			throw this.ackError;
		}
		this.acked = true;
	}

	async nack(): Promise<void> {
		this.nacked = true;
	}
}
