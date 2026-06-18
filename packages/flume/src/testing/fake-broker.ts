import { Subscription } from "../domain/subscription";
import { Topic } from "../domain/topic";
import { Bytes } from "../ports/codec";
import { Broker, DeliveredMessage, RunningConsumer } from "../ports/consumer";
import { FakeDeliveredMessage } from "./fake-delivered-message";
import { PublishedMessage } from "./published-message";

interface Registration {
	sub: Subscription;
	deliver: (msg: DeliveredMessage) => Promise<void>;
	stopped: boolean;
}

// In-memory Broker for fast core tests. It deliberately does NOT auto-deliver on
// publish: a test accumulates published messages, then drives delivery itself —
// mirroring the real broker, where dispatch and consumption are separate. Fresh
// delivery (count 1) and redelivery (count N) are distinct driver calls, because
// Redis surfaces them on distinct occasions and the count is only authoritative
// on reclaim. Building "count accurate on every delivery" into the fake would
// green-light semantics the Redis adapter cannot honor.
export class FakeBroker implements Broker {
	readonly published: PublishedMessage[] = [];
	private readonly registrations = new Map<string, Registration>();

	async publish(topic: Topic, body: Bytes): Promise<void> {
		this.published.push(new PublishedMessage(topic, body));
	}

	async consume(
		sub: Subscription,
		deliver: (msg: DeliveredMessage) => Promise<void>,
	): Promise<RunningConsumer> {
		const registration: Registration = { sub, deliver, stopped: false };
		this.registrations.set(sub.key(), registration);
		return {
			stop: async () => {
				registration.stopped = true;
			},
		};
	}

	// Published messages whose topic matches — e.g. to assert dead-letter routing.
	publishedTo(topicName: string): PublishedMessage[] {
		return this.published.filter((m) => m.topic.name === topicName);
	}

	// Drive a fresh delivery (count 1) to the consumer registered for `sub`.
	async deliverFresh(
		sub: Subscription,
		message: { id: string; body: Bytes; topic?: Topic },
	): Promise<FakeDeliveredMessage> {
		return this.deliver(sub, { ...message, deliveryCount: 1 });
	}

	// Drive a redelivery (the reclaim path) with an explicit count > 1. This is
	// the only occasion the broker supplies an authoritative count.
	async redeliver(
		sub: Subscription,
		message: { id: string; body: Bytes; count: number; topic?: Topic },
	): Promise<FakeDeliveredMessage> {
		if (message.count <= 1) {
			throw new Error(
				`redeliver models reclaim; count must be > 1, got ${message.count}`,
			);
		}
		return this.deliver(sub, {
			id: message.id,
			body: message.body,
			topic: message.topic,
			deliveryCount: message.count,
		});
	}

	private async deliver(
		sub: Subscription,
		message: {
			id: string;
			body: Bytes;
			deliveryCount: number;
			topic?: Topic;
		},
	): Promise<FakeDeliveredMessage> {
		const registration = this.registrations.get(sub.key());
		if (!registration) {
			throw new Error(`no consumer registered for ${sub.key()}`);
		}
		if (registration.stopped) {
			throw new Error(`consumer for ${sub.key()} is stopped`);
		}
		const delivered = new FakeDeliveredMessage(
			message.topic ?? sub.topic,
			message.id,
			message.body,
			message.deliveryCount,
		);
		await registration.deliver(delivered);
		return delivered;
	}
}
