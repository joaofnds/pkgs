import {
	Broker,
	Bytes,
	DeliveredMessage,
	RunningConsumer,
	Subscription,
	Topic,
} from "@joaofnds/flume";
import {
	AckPolicy,
	ConsumerMessages,
	connect,
	DeliverPolicy,
	JetStreamClient,
	JetStreamManager,
	NatsConnection,
	RetentionPolicy,
} from "nats";
import { BrokerNotConnectedError } from "./broker-not-connected-error";
import { NatsDeliveredMessage } from "./nats-delivered-message";
import {
	NatsBrokerOptions,
	ResolvedNatsOptions,
	resolveOptions,
} from "./options";
import { durableFor, STREAM, STREAM_SUBJECTS, subjectFor } from "./subject";

interface Connection {
	readonly nc: NatsConnection;
	readonly js: JetStreamClient;
	readonly jsm: JetStreamManager;
}

export class NatsStreamsBroker implements Broker {
	private connection?: Connection;
	private streamReady = false;
	private readonly running: ConsumerMessages[] = [];
	private readonly options: ResolvedNatsOptions;

	constructor(options: NatsBrokerOptions) {
		this.options = resolveOptions(options);
	}

	async connect(): Promise<void> {
		const nc = await connect(this.options.nats);
		const jsm = await nc.jetstreamManager();
		this.connection = { nc, js: nc.jetstream(), jsm };
	}

	async close(): Promise<void> {
		for (const messages of this.running.splice(0)) {
			messages.stop();
		}
		if (this.connection) {
			await this.connection.nc.close();
			this.connection = undefined;
		}
	}

	async publish(topic: Topic, body: Bytes): Promise<void> {
		const { js } = await this.ready();
		await js.publish(subjectFor(topic.name), body);
	}

	async consume(
		sub: Subscription,
		deliver: (msg: DeliveredMessage) => Promise<void>,
	): Promise<RunningConsumer> {
		const { js } = await this.ready();
		const durable = durableFor(sub, this.options.instanceId);
		await this.ensureConsumer(durable, sub);

		const consumer = await js.consumers.get(STREAM, durable);
		const messages = await consumer.consume({
			max_messages: this.options.readCount,
		});
		this.running.push(messages);
		void this.drain(messages, sub.topic, deliver);

		return {
			stop: async () => {
				messages.stop();
			},
		};
	}

	private async drain(
		messages: ConsumerMessages,
		topic: Topic,
		deliver: (msg: DeliveredMessage) => Promise<void>,
	): Promise<void> {
		try {
			for await (const msg of messages) {
				await deliver(new NatsDeliveredMessage(msg, topic));
			}
		} catch {
			// the iterator throws when the connection closes on shutdown — expected.
		}
	}

	private connected(): Connection {
		if (!this.connection) throw new BrokerNotConnectedError();
		return this.connection;
	}

	private async ready(): Promise<Connection> {
		const connection = this.connected();
		if (this.streamReady) return connection;
		try {
			await connection.jsm.streams.info(STREAM);
		} catch {
			await connection.jsm.streams.add({
				name: STREAM,
				subjects: STREAM_SUBJECTS,
				retention: RetentionPolicy.Limits,
			});
		}
		this.streamReady = true;
		return connection;
	}

	private async ensureConsumer(
		durable: string,
		sub: Subscription,
	): Promise<void> {
		const { jsm } = this.connected();
		try {
			await jsm.consumers.info(STREAM, durable);
			return;
		} catch {
			// not found — create it below.
		}
		await jsm.consumers.add(STREAM, {
			durable_name: durable,
			filter_subject: subjectFor(sub.topic.name),
			ack_policy: AckPolicy.Explicit,
			deliver_policy:
				sub.startFrom === "beginning" ? DeliverPolicy.All : DeliverPolicy.New,
			ack_wait: this.options.ackWait * 1_000_000,
			max_deliver: -1,
		});
	}
}
