import {
	DeliveredMessage,
	DeliveryMode,
	EventHandler,
	RetryPolicy,
	Subscription,
	Topic,
} from "@joaofnds/flume";
import { uniqueTopic, waitFor } from "@joaofnds/flume-tck";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isReadDeadlineError } from "../src/errors";
import { RecordingBrokerProbe } from "../src/test-support/recording-broker-probe";
import { BrokerHarness } from "./support/harness";
import { StallingProxy } from "./support/stalling-proxy";

const NOOP_HANDLER: EventHandler = { async handle() {} };
const CASE_TIMEOUT = 30_000;
const STALL_TIMEOUT = 20_000;

function subscription(topic: string, name: string): Subscription {
	return new Subscription({
		topic: new Topic(topic),
		name,
		handler: NOOP_HANDLER,
		retry: new RetryPolicy({ maxAttempts: 3 }),
		delivery: DeliveryMode.Competing,
	});
}

class Deliveries {
	readonly messages: DeliveredMessage[] = [];
	mode: "ack" | "nack" = "ack";

	deliver = async (msg: DeliveredMessage): Promise<void> => {
		this.messages.push(msg);
		if (this.mode === "ack") await msg.ack();
		else await msg.nack();
	};
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("read deadline", () => {
	let probe: RecordingBrokerProbe;
	let proxy: StallingProxy;

	beforeEach(async () => {
		probe = new RecordingBrokerProbe();
		proxy = await StallingProxy.start();
	});

	afterEach(() => {
		proxy.resume();
		proxy.close();
	});

	async function start(): Promise<BrokerHarness> {
		return BrokerHarness.start({ redis: { url: proxy.url } }, probe);
	}

	async function publish(harness: BrokerHarness, topic: string): Promise<void> {
		await harness.maint.xAdd(topic, "*", { payload: Buffer.from(encode("m")) });
	}

	it(
		"replaces the read client and keeps delivering when a read never answers",
		async () => {
			await using harness = await start();
			const topic = uniqueTopic();
			const deliveries = new Deliveries();
			await harness.broker.consume(
				subscription(topic, "deadline-read"),
				deliveries.deliver,
			);

			proxy.stallOn("XREADGROUP");
			await waitFor(
				() => probe.consumerStalledCalls.some((s) => isReadDeadlineError(s.error)),
				{
					timeout: STALL_TIMEOUT,
					message: "a read whose reply never comes should stall the consumer",
				},
			);

			const stall = probe.consumerStalledCalls.find((s) =>
				isReadDeadlineError(s.error),
			);
			expect(stall?.consecutive).toBe(2);
			expect(probe.consumerStoppedCalls).toEqual([]);

			proxy.resume();
			await publish(harness, topic);
			await waitFor(() => deliveries.messages.length === 1, {
				timeout: STALL_TIMEOUT,
				message: "the consumer should deliver again once the stall clears",
			});
		},
		CASE_TIMEOUT,
	);

	it(
		"reports a stalled reclaim turn, never a reclaim failure",
		async () => {
			await using harness = await start();
			const topic = uniqueTopic();
			const deliveries = new Deliveries();
			proxy.stallOn("XAUTOCLAIM");
			await harness.broker.consume(
				subscription(topic, "deadline-claim"),
				deliveries.deliver,
			);

			await waitFor(
				() => probe.consumerStalledCalls.some((s) => isReadDeadlineError(s.error)),
				{
					timeout: STALL_TIMEOUT,
					message: "a claim whose reply never comes should stall the consumer",
				},
			);

			expect(probe.reclaimFailures).toEqual([]);
			expect(probe.consumerStoppedCalls).toEqual([]);

			proxy.resume();
			await publish(harness, topic);
			await waitFor(() => deliveries.messages.length === 1, {
				timeout: STALL_TIMEOUT,
				message: "the consumer should deliver again once the stall clears",
			});
		},
		CASE_TIMEOUT,
	);

	it(
		"reports a stalled delivery-count batch, never a reclaim failure",
		async () => {
			await using harness = await start();
			const topic = uniqueTopic();
			const deliveries = new Deliveries();
			// nack() is a no-op that issues no command, so the entry stays in the PEL
			// for the reclaim turn and no ack can deadlock behind the stall.
			deliveries.mode = "nack";
			await harness.broker.consume(
				subscription(topic, "deadline-pending"),
				deliveries.deliver,
			);
			await publish(harness, topic);
			await waitFor(() => deliveries.messages.length >= 1, {
				timeout: STALL_TIMEOUT,
				message: "the first delivery should land before the stall is armed",
			});

			proxy.stallOn("XPENDING");
			await waitFor(
				() => probe.consumerStalledCalls.some((s) => isReadDeadlineError(s.error)),
				{
					timeout: STALL_TIMEOUT,
					message: "a pending batch whose reply never comes should stall",
				},
			);

			expect(probe.reclaimFailures).toEqual([]);
			expect(probe.consumerStoppedCalls).toEqual([]);

			proxy.resume();
			const before = deliveries.messages.length;
			await publish(harness, topic);
			await waitFor(() => deliveries.messages.length > before, {
				timeout: STALL_TIMEOUT,
				message: "the consumer should deliver again once the stall clears",
			});
		},
		CASE_TIMEOUT,
	);
});
