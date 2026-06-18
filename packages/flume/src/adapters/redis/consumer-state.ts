import { Topic } from "../../domain/topic";
import { DeliveredMessage } from "../../ports/consumer";
import { AckBatch } from "./ack-batch";
import { ReadClient } from "./clients";

export interface ConsumerState {
	readonly topic: Topic;
	readonly stream: string;
	readonly group: string;
	readonly broadcast: boolean;
	readonly deliver: (msg: DeliveredMessage) => Promise<void>;
	readonly readClient: ReadClient;
	stopped: boolean;
	ackBatch: AckBatch;
}
