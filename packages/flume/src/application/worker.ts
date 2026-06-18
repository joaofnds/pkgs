import { Event, Subscription, Topic } from "../domain";
import {
	Codec,
	Consumer,
	DeliveredMessage,
	Probe,
	Publisher,
	RunningConsumer,
} from "../ports";
import { DeadLetter } from "./dead-letter";
import { Envelope } from "./envelope";
import { GuardedProbe } from "./guarded-probe";

export class DuplicateSubscriptionError extends Error {
	constructor(
		readonly topic: string,
		readonly name: string,
	) {
		super(
			`a subscription for topic "${topic}" with name "${name}" is already registered`,
		);
		this.name = "DuplicateSubscriptionError";
	}
}

export class WorkerAlreadyStartedError extends Error {
	constructor() {
		super("worker already started; register all subscriptions before start()");
		this.name = "WorkerAlreadyStartedError";
	}
}

// Consumer side. Owns the retry/dead-letter POLICY; the broker owns redelivery
// mechanics. The dead-letter decision can only fire on a redelivery (where the
// count is authoritative); a fresh delivery is always count 1, so it always
// attempts the handler.
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

	// Rejects a duplicate {topic, name}: two subs sharing a name would share one
	// consumer group and split work, silently destroying per-handler isolation.
	// Registering after start() would silently never be consumed, so reject it.
	register(sub: Subscription): void {
		if (this.started) {
			throw new WorkerAlreadyStartedError();
		}
		if (this.subscriptions.has(sub.key())) {
			throw new DuplicateSubscriptionError(sub.topic.name, sub.name);
		}
		this.subscriptions.set(sub.key(), sub);
	}

	// Not re-entrant: a second start() would open a duplicate consumer per
	// subscription (on Redis, two blocking XREADGROUP loops in one group), so it
	// fails fast instead of silently double-subscribing.
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
