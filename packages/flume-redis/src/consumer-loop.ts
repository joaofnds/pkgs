import { DeliveredMessage, Topic } from "@joaofnds/flume";
import { Throughput } from "@joaofnds/throughput";
import { AckBatch } from "./ack-batch";
import { ReadClient } from "./clients";
import { ConsumerHandle } from "./consumer-registry";

export class ConsumerLoop implements ConsumerHandle {
	readonly topic: Topic;
	readonly stream: string;
	readonly group: string;
	readonly broadcast: boolean;
	readonly handler: (msg: DeliveredMessage) => Promise<void>;
	readClient: ReadClient;
	readonly throughput: Throughput;
	stopped = false;
	readClientAborted = false;
	consecutiveReadFailures = 0;
	reclaimCursor = "0";
	lastReclaimAt = 0;
	ackBatch = new AckBatch();

	constructor(props: {
		topic: Topic;
		stream: string;
		group: string;
		broadcast: boolean;
		handler: (msg: DeliveredMessage) => Promise<void>;
		readClient: ReadClient;
		throughput: Throughput;
	}) {
		this.topic = props.topic;
		this.stream = props.stream;
		this.group = props.group;
		this.broadcast = props.broadcast;
		this.handler = props.handler;
		this.readClient = props.readClient;
		this.throughput = props.throughput;
	}

	throughputPerSecond(): number {
		return this.throughput.perSecond();
	}

	stop(): void {
		this.stopped = true;
		this.throughput.stop();
		if (this.readClient.isOpen) this.readClient.destroy();
	}
}
