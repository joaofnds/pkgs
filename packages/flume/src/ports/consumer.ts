import { Subscription } from "../domain/subscription";
import { Topic } from "../domain/topic";
import { Bytes } from "./codec";
import { Publisher } from "./publisher";

export interface DeliveredMessage {
	readonly topic: Topic;
	readonly id: string;
	readonly body: Bytes;
	readonly deliveryCount: number;
	ack(): Promise<void>;
	nack(): Promise<void>;
}

export interface RunningConsumer {
	stop(): Promise<void>;
}

export interface Consumer {
	consume(
		sub: Subscription,
		deliver: (msg: DeliveredMessage) => Promise<void>,
	): Promise<RunningConsumer>;
}

export type Broker = Publisher & Consumer;
