import { Bytes, DeliveredMessage, Topic } from "@joaofnds/flume";

export class RedisDeliveredMessage implements DeliveredMessage {
	constructor(
		readonly topic: Topic,
		readonly id: string,
		readonly body: Bytes,
		readonly deliveryCount: number,
		private readonly acker: () => Promise<void>,
	) {}

	async ack(): Promise<void> {
		await this.acker();
	}

	async nack(): Promise<void> {
		// No-op: entry stays in the PEL; the reclaim loop redelivers it after minIdleTime.
	}
}
