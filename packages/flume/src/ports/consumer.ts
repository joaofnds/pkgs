import { Subscription } from "../domain/subscription";
import { Topic } from "../domain/topic";
import { Bytes } from "./codec";
import { Publisher } from "./publisher";

// One delivered message. The adapter surfaces BOTH fresh reads and reclaimed
// redeliveries through the same shape; `deliveryCount` distinguishes them
// (1 on a fresh delivery, > 1 only on a redelivery). It owns all redelivery
// mechanics (reclaim, idle timeouts, group management).
export interface DeliveredMessage {
	readonly topic: Topic;
	readonly id: string;
	readonly body: Bytes;
	readonly deliveryCount: number;
	ack(): Promise<void>; // processed OK — remove from the pending set
	nack(): Promise<void>; // leave pending → reclaim loop redelivers it later
}

export interface RunningConsumer {
	stop(): Promise<void>;
}

// Consumer side. The adapter delivers every message — fresh and reclaimed —
// through the one `deliver` callback.
export interface Consumer {
	consume(
		sub: Subscription,
		deliver: (msg: DeliveredMessage) => Promise<void>,
	): Promise<RunningConsumer>;
}

// A broker is just both roles. The Redis adapter implements both; the API tier
// may construct only the Publisher half, the worker tier only the Consumer half.
export type Broker = Publisher & Consumer;
