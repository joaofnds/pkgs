import { DeadLetter } from "../domain/dead-letter";
import { Event } from "../domain/event";
import { Subscription } from "../domain/subscription";
import { Topic } from "../domain/topic";
import { Codec } from "../ports/codec";
import { Consumer, DeliveredMessage, RunningConsumer } from "../ports/consumer";
import { Probe } from "../ports/probe";
import { Publisher } from "../ports/publisher";
import { DuplicateSubscriptionError } from "./duplicate-subscription-error";
import { Envelope } from "./envelope";
import { GuardedProbe } from "./guarded-probe";
import { WorkerAlreadyStartedError } from "./worker-already-started-error";

export class Worker {
	private readonly probe: Probe;
	private readonly subscriptions = new Map<string, Subscription>();
	private readonly running: RunningConsumer[] = [];
	private started = false;

	constructor(
		private readonly consumer: Consumer,
		private readonly publisher: Publisher,
		private readonly codec: Codec,
		probe: Probe,
	) {
		this.probe = new GuardedProbe(probe);
	}

	register(sub: Subscription): void {
		if (this.started) {
			throw new WorkerAlreadyStartedError();
		}
		if (this.subscriptions.has(sub.key())) {
			throw new DuplicateSubscriptionError(sub.topic.name, sub.name);
		}
		this.subscriptions.set(sub.key(), sub);
	}

	async start(): Promise<void> {
		if (this.started) {
			throw new WorkerAlreadyStartedError();
		}
		this.started = true;
		for (const sub of this.subscriptions.values()) {
			const running = await this.consumer.consume(sub, (msg) =>
				this.process(sub, msg),
			);
			this.running.push(running);
		}
	}

	async stop(): Promise<void> {
		const running = this.running.splice(0);
		for (const consumer of running) {
			await consumer.stop();
		}
	}

	private async process(
		sub: Subscription,
		msg: DeliveredMessage,
	): Promise<void> {
		if (sub.retry.exhaustedBy(msg.deliveryCount)) {
			const deadLetter = new DeadLetter({ originalId: msg.id, body: msg.body });
			await this.publisher.publish(
				this.deadLetterTopic(sub),
				deadLetter.toBytes(),
			);
			await msg.ack();
			this.probe.deadLettered(sub, msg);
			return;
		}

		try {
			const envelope = Envelope.parse(msg.body);
			const event = new Event({
				topic: msg.topic,
				payload: this.codec.decode(envelope.payload),
				id: msg.id,
				deliveryCount: msg.deliveryCount,
				dispatchedAt: envelope.dispatchedAt,
			});
			await sub.handler.handle(event);
			await msg.ack();
			this.probe.processed(sub, msg);
		} catch (error) {
			await msg.nack();
			this.probe.failed(sub, msg, error);
		}
	}

	private deadLetterTopic(sub: Subscription): Topic {
		return new Topic(`${sub.topic.name}:dead:${sub.name}`);
	}
}
