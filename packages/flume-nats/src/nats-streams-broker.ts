import {
	Broker,
	Bytes,
	DeliveredMessage,
	RunningConsumer,
	Subscription,
	Topic,
} from "@joaofnds/flume";
import {
	ConsumerMessages,
	JetStreamClient,
	JetStreamManager,
	jetstream,
	jetstreamManager,
} from "@nats-io/jetstream";
import { NatsConnection } from "@nats-io/nats-core";
import { connect } from "@nats-io/transport-node";
import { BrokerNotConnectedError } from "./broker-not-connected-error";
import { BrokerProbe } from "./broker-probe";
import { ConnectionLifecycle } from "./connection-lifecycle";
import { ConsumerDrain } from "./consumer-drain";
import { ConsumerHealth } from "./consumer-health";
import { GuardedBrokerProbe } from "./guarded-broker-probe";
import { ensureConsumer, ensureStream } from "./jetstream-topology";
import { NoopBrokerProbe } from "./noop-broker-probe";
import {
	NatsBrokerOptions,
	ResolvedNatsOptions,
	resolveOptions,
} from "./options";
import { durableFor, STREAM, subjectFor } from "./subject";

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
	private readonly probe: BrokerProbe;

	constructor(
		options: NatsBrokerOptions,
		probe: BrokerProbe = new NoopBrokerProbe(),
	) {
		this.options = resolveOptions(options);
		this.probe = new GuardedBrokerProbe(probe);
	}

	async connect(): Promise<void> {
		const nc = await connect({ noAsyncTraces: true, ...this.options.nats });

		try {
			const jsm = await jetstreamManager(nc);
			this.connection = { nc, js: jetstream(nc), jsm };
		} catch (error) {
			await nc.close();
			throw error;
		}

		this.probe.connected();
		void new ConnectionLifecycle(this.probe).watch(nc);
	}

	async close(): Promise<void> {
		for (const messages of this.running.splice(0)) {
			messages.stop();
		}
		if (this.connection) {
			await this.connection.nc.close();
			this.connection = undefined;
			this.streamReady = false;
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
		const { js, jsm } = await this.ready();
		const durable = durableFor(sub, this.options.instanceId);
		await ensureConsumer(jsm, durable, sub, this.options.ackWait);

		const consumer = await js.consumers.get(STREAM, durable);
		const messages = await consumer.consume({
			max_messages: this.options.concurrency,
		});
		// registered before any await: notify() only reaches listeners already
		// registered, and the initial pull fires from the constructor
		const status = messages.status();
		this.running.push(messages);
		void new ConsumerHealth(this.probe).watch(
			status,
			subjectFor(sub.topic.name),
			durable,
		);
		void new ConsumerDrain(this.probe, this.options.concurrency).drain(
			messages,
			sub.topic,
			durable,
			deliver,
		);

		return {
			stop: async () => {
				messages.stop();
			},
		};
	}

	private connected(): Connection {
		if (!this.connection) throw new BrokerNotConnectedError();
		return this.connection;
	}

	private async ready(): Promise<Connection> {
		const connection = this.connected();
		if (this.streamReady) return connection;

		await ensureStream(connection.jsm);
		this.streamReady = true;

		return connection;
	}
}
