import { DeliveredMessage, Topic } from "@joaofnds/flume";
import { JsMsg } from "@nats-io/jetstream";
import { BrokerProbe } from "./broker-probe";
import { NatsDeliveredMessage } from "./nats-delivered-message";
import { subjectFor } from "./subject";

function isExpectedShutdown(error: unknown): boolean {
	return error instanceof Error && error.name === "ClosedConnectionError";
}

export class ConsumerDrain {
	constructor(
		private readonly probe: BrokerProbe,
		private readonly concurrency: number,
	) {}

	async drain(
		source: AsyncIterable<JsMsg>,
		topic: Topic,
		durable: string,
		deliver: (msg: DeliveredMessage) => Promise<void>,
	): Promise<void> {
		const inFlight = new Set<Promise<void>>();

		try {
			for await (const msg of source) {
				const task = this.handle(msg, topic, deliver);
				inFlight.add(task);
				task.finally(() => inFlight.delete(task));
				if (inFlight.size >= this.concurrency) {
					await Promise.race(inFlight);
				}
			}
		} catch (error) {
			// never rethrown: drain() is un-awaited, so a rethrow becomes an unhandled rejection
			if (!isExpectedShutdown(error)) {
				this.probe.consumerStopped(subjectFor(topic.name), durable, error);
			}
		}

		await Promise.allSettled(inFlight);
	}

	private async handle(
		msg: JsMsg,
		topic: Topic,
		deliver: (msg: DeliveredMessage) => Promise<void>,
	): Promise<void> {
		try {
			await deliver(new NatsDeliveredMessage(msg, topic));
		} catch (error) {
			this.probe.deliveryFailed(error);
		}
	}
}
