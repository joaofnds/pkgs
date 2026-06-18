import { Topic } from "../../domain/topic";
import { Bytes } from "../../ports/codec";
import { DeliveredMessage } from "../../ports/consumer";

// One Redis Stream entry handed to the Worker. `ack` is XACK (remove from the
// pending entries list); `nack` is deliberately a NO-OP — leaving the entry in the
// PEL is exactly how Redis redelivery works: the reclaim loop picks it up after
// minIdleTime. The Worker makes the dead-letter decision; this message only
// reports its delivery count truthfully (1 on a fresh read, the broker-tracked
// count on a reclaim).
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
		// No-op: the entry stays in the PEL and the reclaim loop redelivers it after
		// minIdleTime. Nothing redelivers it immediately (PRD §7).
	}
}
