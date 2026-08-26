import {
	ConsumerConfig,
	JetStreamApiCodes,
	JetStreamApiError,
	RetentionPolicy,
	StreamConfig,
} from "@nats-io/jetstream";
import { beforeEach, describe, expect, it } from "vitest";
import { ensureStream, JetStreamAdmin } from "./jetstream-topology";
import { STREAM, STREAM_SUBJECTS } from "./subject";

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
