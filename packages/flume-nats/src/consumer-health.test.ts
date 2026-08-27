import { Clock } from "@joaofnds/flume";
import { FakeClock } from "@joaofnds/flume/testing";
import { ConsumerNotification } from "@nats-io/jetstream";
import { beforeEach, describe, expect, it } from "vitest";
import {
	BrokerProbe,
	ConsumerDegradation,
	ConsumerStall,
	DegradationReason,
	StallReason,
} from "./broker-probe";
import { ConsumerHealth, REPORT_INTERVAL_MS } from "./consumer-health";
import { RecordingBrokerProbe } from "./test-support/recording-broker-probe";
import { ThrowingBrokerProbe } from "./test-support/throwing-broker-probe";

const SUBJECT = "flume.orders";
const DURABLE = "orders__workers";

const DELETED: ConsumerNotification = {
	type: "consumer_deleted",
	code: 409,
	description: "consumer deleted",
};

const NO_RESPONDERS: ConsumerNotification = {
	type: "no_responders",
	code: 503,
};

interface StallCase {
	notification: ConsumerNotification;
	reason: StallReason;
	// the library's own consecutive-failure count. Only heartbeats_missed and
	// consumer_not_found carry one; the reachable stream_not_found emits
	// { type, name } alone.
	consecutive?: number;
}

const STALLING: StallCase[] = [
	{ notification: DELETED, reason: "consumer_deleted" },
	{
		notification: {
			type: "consumer_not_found",
			name: DURABLE,
			stream: "flume",
			count: 1,
		},
		reason: "consumer_not_found",
		consecutive: 1,
	},
	{
		notification: { type: "stream_not_found", name: "flume" },
		reason: "stream_not_found",
	},
	{
		notification: { type: "heartbeats_missed", count: 2 },
		reason: "heartbeats_missed",
		consecutive: 2,
	},
];

interface DegradationCase {
	notification: ConsumerNotification;
	reason: DegradationReason;
}

const DEGRADING: DegradationCase[] = [
	{ notification: NO_RESPONDERS, reason: "no_responders" },
	{
		notification: {
			type: "exceeded_limits",
			code: 409,
			description: "max waiting",
		},
		reason: "exceeded_limits",
	},
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

function stall(
	reason: StallReason,
	occurrences: number,
	consecutive?: number,
): ConsumerStall {
	return {
		subject: SUBJECT,
		durable: DURABLE,
		reason,
		occurrences,
		consecutive,
	};
}

function degradation(
	reason: DegradationReason,
	occurrences: number,
): ConsumerDegradation {
	return { subject: SUBJECT, durable: DURABLE, reason, occurrences };
}

function watch(
	probe: BrokerProbe,
	source: AsyncIterable<ConsumerNotification>,
	clock?: Clock,
): Promise<void> {
	return new ConsumerHealth(probe, clock).watch(source, SUBJECT, DURABLE);
}

async function* sourceOf(
	...notifications: ConsumerNotification[]
): AsyncIterable<ConsumerNotification> {
	for (const notification of notifications) yield notification;
}

async function* failing(
	source: AsyncIterable<ConsumerNotification>,
	error: unknown,
): AsyncIterable<ConsumerNotification> {
	yield* source;
	throw error;
}

type Step = ConsumerNotification | { advance: number };

// The clock has to move from inside the generator: watch() is awaited as a
// whole, so an advance() written after it cannot land between two arrivals.
async function* scripted(
	clock: FakeClock,
	...steps: Step[]
): AsyncIterable<ConsumerNotification> {
	for (const step of steps) {
		if ("advance" in step) clock.advance(step.advance);
		else yield step;
	}
}

describe(ConsumerHealth, () => {
	let probe: RecordingBrokerProbe;

	beforeEach(() => {
		probe = new RecordingBrokerProbe();
	});

	it.each(STALLING)(
		"reports $reason as a consumer stall",
		async ({ notification, reason, consecutive }) => {
			await watch(probe, sourceOf(notification));

			expect(probe.consumerStalledCalls).toEqual([
				stall(reason, 1, consecutive),
			]);
			expect(probe.consumerDegradedCalls).toEqual([]);
		},
	);

	it.each(DEGRADING)(
		"reports $reason as a consumer degradation",
		async ({ notification, reason }) => {
			await watch(probe, sourceOf(notification));

			expect(probe.consumerDegradedCalls).toEqual([degradation(reason, 1)]);
			expect(probe.consumerStalledCalls).toEqual([]);
		},
	);

	it.each(ROUTINE)("reports nothing for $type", async (notification) => {
		await watch(probe, sourceOf(notification));

		expect(probe.consumerStalledCalls).toEqual([]);
		expect(probe.consumerDegradedCalls).toEqual([]);
	});

	it("emits once per reason per report interval, counting the suppressed arrivals", async () => {
		const clock = new FakeClock();

		await watch(
			probe,
			scripted(
				clock,
				DELETED,
				DELETED,
				DELETED,
				{ advance: REPORT_INTERVAL_MS },
				DELETED,
			),
			clock,
		);

		expect(probe.consumerStalledCalls).toEqual([
			stall("consumer_deleted", 1),
			stall("consumer_deleted", 3),
		]);
	});

	it("flushes the suppressed residue when the source ends", async () => {
		const clock = new FakeClock();

		await watch(probe, scripted(clock, DELETED, DELETED), clock);

		expect(probe.consumerStalledCalls).toEqual([
			stall("consumer_deleted", 1),
			stall("consumer_deleted", 1),
		]);
	});

	it("bounds each reason on its own schedule", async () => {
		const clock = new FakeClock();

		await watch(probe, scripted(clock, DELETED, NO_RESPONDERS), clock);

		expect(probe.consumerStalledCalls).toEqual([stall("consumer_deleted", 1)]);
		expect(probe.consumerDegradedCalls).toEqual([
			degradation("no_responders", 1),
		]);
	});

	it("ignores a notification type the table does not know", async () => {
		const unknown = {
			type: "not_a_real_type",
		} as unknown as ConsumerNotification;

		await watch(probe, sourceOf(unknown, DELETED));

		expect(probe.consumerStalledCalls).toEqual([stall("consumer_deleted", 1)]);
	});

	it("flushes the residue and reports status_watch_failed when the loop throws", async () => {
		const clock = new FakeClock();

		await watch(
			probe,
			failing(scripted(clock, DELETED, DELETED), new Error("status boom")),
			clock,
		);

		expect(probe.consumerStalledCalls).toEqual([
			stall("consumer_deleted", 1),
			stall("consumer_deleted", 1),
		]);
		expect(probe.consumerDegradedCalls).toEqual([
			degradation("status_watch_failed", 1),
		]);
	});

	it("reports no status_watch_failed when the source ends cleanly", async () => {
		await watch(probe, sourceOf(DELETED));

		expect(probe.consumerDegradedCalls).toEqual([]);
	});

	it("resolves even when every probe call throws", async () => {
		await expect(
			watch(new ThrowingBrokerProbe(), sourceOf(DELETED, NO_RESPONDERS)),
		).resolves.toBeUndefined();
	});
});
