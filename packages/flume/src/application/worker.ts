import { DeadLetter } from "../domain/dead-letter";
import { Event } from "../domain/event";
import { Subscription } from "../domain/subscription";
import { Topic } from "../domain/topic";
import { Clock } from "../ports/clock";
import { Codec } from "../ports/codec";
import { Consumer, DeliveredMessage, RunningConsumer } from "../ports/consumer";
import { Probe } from "../ports/probe";
import { ProcessingTiming } from "../ports/processing-timing";
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
		private readonly clock: Clock,
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
			await this.ack(sub, msg);
			this.probe.deadLettered(sub, msg);
			return;
		}

		let timing: ProcessingTiming;
		try {
			timing = await this.attempt(sub, msg);
		} catch (error) {
			await msg.nack();
			this.probe.failed(sub, msg, error);
			return;
		}

		await this.ack(sub, msg);
		this.probe.processed(sub, msg, timing);
	}

	private async attempt(
		sub: Subscription,
		msg: DeliveredMessage,
	): Promise<ProcessingTiming> {
		const envelope = Envelope.parse(msg.body);
		const event = new Event({
			topic: msg.topic,
			payload: this.codec.decode(envelope.payload),
			id: msg.id,
			deliveryCount: msg.deliveryCount,
			dispatchedAt: envelope.dispatchedAt,
		});

		const start = this.clock.now();
		await sub.handler.handle(event);
		const end = this.clock.now();

		return {
			handlerDurationMs: end.getTime() - start.getTime(),
			endToEndLatencyMs: end.getTime() - envelope.dispatchedAt.getTime(),
		};
	}

	private async ack(sub: Subscription, msg: DeliveredMessage): Promise<void> {
		try {
			await msg.ack();
		} catch (error) {
			this.probe.ackFailed(sub, msg, error);
			throw error;
		}
	}

	private deadLetterTopic(sub: Subscription): Topic {
		return new Topic(`${sub.topic.name}:dead:${sub.name}`);
	}
}
