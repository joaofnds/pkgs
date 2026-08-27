import { ProbeLogger } from "@joaofnds/flume";
import { beforeEach, describe, expect, it } from "vitest";
import { LoggingBrokerProbe } from "./logging-broker-probe";

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

describe(LoggingBrokerProbe, () => {
	let logger: RecordingLogger;
	let probe: LoggingBrokerProbe;

	beforeEach(() => {
		logger = new RecordingLogger();
		probe = new LoggingBrokerProbe(logger);
	});

	it("logs a connection at info", () => {
		probe.connected();

		expect(logger.lines).toEqual([
			{ level: "info", event: "flume.broker.connected", fields: {} },
		]);
	});

	it("logs a disconnection at error", () => {
		probe.disconnected();

		expect(logger.lines).toEqual([
			{ level: "error", event: "flume.broker.disconnected", fields: {} },
		]);
	});

	it("logs a reconnection at info", () => {
		probe.reconnected();

		expect(logger.lines).toEqual([
			{ level: "info", event: "flume.broker.reconnected", fields: {} },
		]);
	});

	it("logs a delivery failure at error with the reason", () => {
		probe.deliveryFailed(new Error("deliver blew up"));

		expect(logger.lines).toEqual([
			{
				level: "error",
				event: "flume.broker.delivery_failed",
				fields: { error: "deliver blew up" },
			},
		]);
	});

	it("logs a consumer stop at error with the subject, durable and reason", () => {
		probe.consumerStopped({
			subject: "flume.orders",
			durable: "orders__workers",
			error: new Error("permission violation"),
		});

		expect(logger.lines).toEqual([
			{
				level: "error",
				event: "flume.broker.consumer_stopped",
				fields: {
					subject: "flume.orders",
					durable: "orders__workers",
					error: "permission violation",
				},
			},
		]);
	});

	it("stringifies a non-Error failure reason", () => {
		probe.deliveryFailed("plain string reason");

		expect(logger.lines[0].fields.error).toBe("plain string reason");
	});
});
