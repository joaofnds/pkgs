import { beforeEach, describe, expect, it } from "vitest";
import { DeliveryMode } from "../domain/delivery-mode";
import { RetryPolicy } from "../domain/retry-policy";
import { Subscription } from "../domain/subscription";
import { Topic } from "../domain/topic";
import { DeliveredMessage } from "../ports/consumer";
import { RecordingHandler } from "../test-support/recording-handler";
import { LoggingProbe } from "./logging-probe";
import { ProbeLogger } from "./probe-logger";

interface Line {
	level: "info" | "error";
	event: string;
	fields: Record<string, unknown>;
}

class RecordingLogger implements ProbeLogger {
	readonly lines: Line[] = [];

	info(event: string, fields: Record<string, unknown>): void {
		this.lines.push({ level: "info", event, fields });
	}

	error(event: string, fields: Record<string, unknown>): void {
		this.lines.push({ level: "error", event, fields });
	}
}

const topic = new Topic("user.created");
const sub = new Subscription({
	topic,
	name: "svc:send-email",
	handler: new RecordingHandler(),
	retry: new RetryPolicy({ maxAttempts: 3 }),
	delivery: DeliveryMode.Competing,
});

function message(deliveryCount = 1): DeliveredMessage {
	return {
		topic,
		id: "1718-0",
		body: new Uint8Array(),
		deliveryCount,
		async ack() {},
		async nack() {},
	};
}

describe(LoggingProbe, () => {
	let logger: RecordingLogger;
	let probe: LoggingProbe;

	beforeEach(() => {
		logger = new RecordingLogger();
		probe = new LoggingProbe(logger);
	});

	it("logs a dispatch at info with the topic", () => {
		probe.dispatched(topic);

		expect(logger.lines).toEqual([
			{
				level: "info",
				event: "flume.dispatched",
				fields: { topic: "user.created" },
			},
		]);
	});

	it("logs a processed message at info with subscription and delivery context", () => {
		probe.processed(sub, message(2));

		expect(logger.lines).toEqual([
			{
				level: "info",
				event: "flume.processed",
				fields: {
					subscription: "svc:send-email",
					topic: "user.created",
					id: "1718-0",
					deliveryCount: 2,
				},
			},
		]);
	});

	it("logs a failure at error with the error message", () => {
		probe.failed(sub, message(), new Error("handler blew up"));

		expect(logger.lines).toEqual([
			{
				level: "error",
				event: "flume.failed",
				fields: {
					subscription: "svc:send-email",
					topic: "user.created",
					id: "1718-0",
					deliveryCount: 1,
					error: "handler blew up",
				},
			},
		]);
	});

	it("stringifies a non-Error failure reason", () => {
		probe.failed(sub, message(), "plain string reason");

		expect(logger.lines[0].fields.error).toBe("plain string reason");
	});

	it("logs a dead-letter at error", () => {
		probe.deadLettered(sub, message(4));

		expect(logger.lines).toEqual([
			{
				level: "error",
				event: "flume.dead_lettered",
				fields: {
					subscription: "svc:send-email",
					topic: "user.created",
					id: "1718-0",
					deliveryCount: 4,
				},
			},
		]);
	});
});
