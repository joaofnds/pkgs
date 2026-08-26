import { Subscription } from "@joaofnds/flume";
import {
	AckPolicy,
	ConsumerConfig,
	DeliverPolicy,
	JetStreamApiCodes,
	JetStreamApiError,
	RetentionPolicy,
	StreamConfig,
} from "@nats-io/jetstream";
import { STREAM, STREAM_SUBJECTS, subjectFor } from "./subject";

export interface JetStreamAdmin {
	streams: {
		info(stream: string): Promise<unknown>;
		add(cfg: Partial<StreamConfig> & { name: string }): Promise<unknown>;
	};
	consumers: {
		info(stream: string, consumer: string): Promise<unknown>;
		add(stream: string, cfg: Partial<ConsumerConfig>): Promise<unknown>;
	};
}

function hasApiCode(error: unknown, code: number): boolean {
	return error instanceof JetStreamApiError && error.code === code;
}

export async function ensureStream(admin: JetStreamAdmin): Promise<void> {
	try {
		await admin.streams.info(STREAM);
	} catch (error) {
		if (!hasApiCode(error, JetStreamApiCodes.StreamNotFound)) throw error;

		await admin.streams.add({
			name: STREAM,
			subjects: STREAM_SUBJECTS,
			retention: RetentionPolicy.Limits,
		});
	}
}

export async function ensureConsumer(
	admin: JetStreamAdmin,
	durable: string,
	sub: Subscription,
	ackWaitMs: number,
): Promise<void> {
	try {
		await admin.consumers.info(STREAM, durable);
		return;
	} catch {
		// not found — create it below.
	}

	await admin.consumers.add(STREAM, {
		durable_name: durable,
		filter_subject: subjectFor(sub.topic.name),
		ack_policy: AckPolicy.Explicit,
		deliver_policy:
			sub.startFrom === "beginning" ? DeliverPolicy.All : DeliverPolicy.New,
		ack_wait: ackWaitMs * 1_000_000,
		max_deliver: -1,
	});
}
