import { DeliveredMessage, Topic } from "@joaofnds/flume";
import { Throughput } from "@joaofnds/throughput";
import { AckBatch } from "./ack-batch";
import { ReadClient } from "./clients";

export interface ConsumerState {
	readonly topic: Topic;
	readonly stream: string;
	readonly group: string;
	readonly broadcast: boolean;
	readonly deliver: (msg: DeliveredMessage) => Promise<void>;
	readonly readClient: ReadClient;
	readonly throughput: Throughput;
	stopped: boolean;
	consecutiveReadFailures: number;
	reclaimCursor: string;
	lastReclaimAt: number;
	ackBatch: AckBatch;
}
