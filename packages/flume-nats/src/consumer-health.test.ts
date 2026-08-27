import { ConsumerNotification } from "@nats-io/jetstream";
import { beforeEach, describe, expect, it } from "vitest";
import { ConsumerHealth } from "./consumer-health";
import { RecordingBrokerProbe } from "./test-support/recording-broker-probe";

const SUBJECT = "flume.orders";
const DURABLE = "orders__workers";

const STALLING: ConsumerNotification[] = [
	{ type: "consumer_deleted", code: 409, description: "consumer deleted" },
	{ type: "consumer_not_found", name: DURABLE, stream: "flume", count: 1 },
	{ type: "stream_not_found", name: "flume" },
	{ type: "heartbeats_missed", count: 2 },
];

const DEGRADING: ConsumerNotification[] = [
	{ type: "no_responders", code: 503 },
	{ type: "exceeded_limits", code: 409, description: "max waiting" },
];

const ROUTINE: ConsumerNotification[] = [
	{ type: "debug", code: 100, description: "ignored status" },
	{ type: "discard", messagesLeft: 3, bytesLeft: 512 },
	{
		type: "next",
		options: {
			batch: 10,
			no_wait: false,
			expires: 30_000,
			max_bytes: 0,
			idle_heartbeat: 15_000,
		},
	},
	{ type: "heartbeat", lastConsumerSequence: 7, lastStreamSequence: 9 },
	{ type: "flow_control" },
	{ type: "consumer_pinned", id: "pin-1" },
	{ type: "consumer_unpinned" },
	{ type: "reset", name: DURABLE },
	{ type: "ordered_consumer_recreated", name: DURABLE },
];

async function* sourceOf(
	...notifications: ConsumerNotification[]
): AsyncIterable<ConsumerNotification> {
	for (const notification of notifications) yield notification;
}

describe(ConsumerHealth, () => {
	let probe: RecordingBrokerProbe;

	beforeEach(() => {
		probe = new RecordingBrokerProbe();
	});

	it.each(STALLING)(
		"reports $type as a consumer stall",
		async (notification) => {
			await new ConsumerHealth(probe).watch(
				sourceOf(notification),
				SUBJECT,
				DURABLE,
			);

			expect(probe.consumerStalledCalls).toEqual([
				{
					subject: SUBJECT,
					durable: DURABLE,
					reason: notification.type,
					occurrences: 1,
				},
			]);
			expect(probe.consumerDegradedCalls).toEqual([]);
		},
	);

	it.each(DEGRADING)(
		"reports $type as a consumer degradation",
		async (notification) => {
			await new ConsumerHealth(probe).watch(
				sourceOf(notification),
				SUBJECT,
				DURABLE,
			);

			expect(probe.consumerDegradedCalls).toEqual([
				{
					subject: SUBJECT,
					durable: DURABLE,
					reason: notification.type,
					occurrences: 1,
				},
			]);
			expect(probe.consumerStalledCalls).toEqual([]);
		},
	);

	it.each(ROUTINE)("reports nothing for $type", async (notification) => {
		await new ConsumerHealth(probe).watch(
			sourceOf(notification),
			SUBJECT,
			DURABLE,
		);

		expect(probe.consumerStalledCalls).toEqual([]);
		expect(probe.consumerDegradedCalls).toEqual([]);
	});
});
