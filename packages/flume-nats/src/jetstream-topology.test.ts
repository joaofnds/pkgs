import {
	DeliveryMode,
	RetryPolicy,
	Subscription,
	Topic,
} from "@joaofnds/flume";
import {
	AckPolicy,
	ConsumerConfig,
	DeliverPolicy,
	JetStreamApiCodes,
	JetStreamApiError,
	RetentionPolicy,
	StreamConfig,
} from "@nats-io/jetstream";
import { beforeEach, describe, expect, it } from "vitest";
import {
	ensureConsumer,
	ensureStream,
	JetStreamAdmin,
} from "./jetstream-topology";
import { STREAM, STREAM_SUBJECTS, subjectFor } from "./subject";

function subscription(topic: string): Subscription {
	return new Subscription({
		topic: new Topic(topic),
		name: "workers",
		handler: { async handle() {} },
		retry: new RetryPolicy({ maxAttempts: 3 }),
		delivery: DeliveryMode.Competing,
	});
}

type StreamAddConfig = Partial<StreamConfig> & { name: string };

class FakeJetStreamAdmin implements JetStreamAdmin {
	readonly addedStreams: StreamAddConfig[] = [];
	readonly addedConsumers: Partial<ConsumerConfig>[] = [];

	private streamInfoError?: unknown;
	private consumerInfoError?: unknown;

	readonly streams = {
		info: async (): Promise<unknown> => {
			if (this.streamInfoError) throw this.streamInfoError;
			return {};
		},
		add: async (cfg: StreamAddConfig): Promise<unknown> => {
			this.addedStreams.push(cfg);
			return {};
		},
	};

	readonly consumers = {
		info: async (): Promise<unknown> => {
			if (this.consumerInfoError) throw this.consumerInfoError;
			return {};
		},
		add: async (
			_stream: string,
			cfg: Partial<ConsumerConfig>,
		): Promise<unknown> => {
			this.addedConsumers.push(cfg);
			return {};
		},
	};

	failStreamInfo(error: unknown): void {
		this.streamInfoError = error;
	}

	failConsumerInfo(error: unknown): void {
		this.consumerInfoError = error;
	}
}

describe(ensureStream, () => {
	let admin: FakeJetStreamAdmin;

	beforeEach(() => {
		admin = new FakeJetStreamAdmin();
	});

	it("creates the stream when the lookup reports it missing", async () => {
		admin.failStreamInfo(
			new JetStreamApiError({
				code: 404,
				description: "stream not found",
				err_code: JetStreamApiCodes.StreamNotFound,
			}),
		);

		await ensureStream(admin);

		expect(admin.addedStreams).toEqual([
			{
				name: STREAM,
				subjects: STREAM_SUBJECTS,
				retention: RetentionPolicy.Limits,
			},
		]);
	});

	describe("when the lookup fails for any other reason", () => {
		it("rethrows and creates no stream", async () => {
			const failure = new Error("boom");
			admin.failStreamInfo(failure);

			await expect(ensureStream(admin)).rejects.toBe(failure);

			expect(admin.addedStreams).toEqual([]);
		});
	});
});

describe(ensureConsumer, () => {
	let admin: FakeJetStreamAdmin;

	beforeEach(() => {
		admin = new FakeJetStreamAdmin();
	});

	it("creates the consumer when the lookup reports it missing", async () => {
		admin.failConsumerInfo(
			new JetStreamApiError({
				code: 404,
				description: "consumer not found",
				err_code: JetStreamApiCodes.ConsumerNotFound,
			}),
		);

		await ensureConsumer(
			admin,
			"orders__workers",
			subscription("orders"),
			5000,
		);

		expect(admin.addedConsumers).toEqual([
			{
				durable_name: "orders__workers",
				filter_subject: subjectFor("orders"),
				ack_policy: AckPolicy.Explicit,
				deliver_policy: DeliverPolicy.New,
				ack_wait: 5_000_000_000,
				max_deliver: -1,
			},
		]);
	});

	it("leaves an existing consumer alone", async () => {
		await ensureConsumer(
			admin,
			"orders__workers",
			subscription("orders"),
			5000,
		);

		expect(admin.addedConsumers).toEqual([]);
	});

	describe("when the lookup fails for any other reason", () => {
		it("rethrows and creates no consumer", async () => {
			const failure = new Error("boom");
			admin.failConsumerInfo(failure);

			await expect(
				ensureConsumer(admin, "orders__workers", subscription("orders"), 5000),
			).rejects.toBe(failure);

			expect(admin.addedConsumers).toEqual([]);
		});
	});
});
