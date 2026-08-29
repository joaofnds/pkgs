import { ProbeLogger } from "@joaofnds/flume";
import { beforeEach, describe, expect, it } from "vitest";
import { LoggingBrokerProbe } from "./logging-broker-probe";

interface Line {
	level: "info" | "warn" | "error";
	event: string;
	fields: Record<string, unknown>;
}

class RecordingLogger implements ProbeLogger {
	readonly lines: Line[] = [];

	info(event: string, fields: Record<string, unknown>): void {
		this.lines.push({ level: "info", event, fields });
	}

	warn(event: string, fields: Record<string, unknown>): void {
		this.lines.push({ level: "warn", event, fields });
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

	it("logs a connection abandoned at error with the reason", () => {
		probe.connectionAbandoned(new Error("gave up reconnecting"));

		expect(logger.lines).toEqual([
			{
				level: "error",
				event: "flume.broker.connection_abandoned",
				fields: { error: "gave up reconnecting" },
			},
		]);
	});

	it("logs reclaimed messages at info with the count", () => {
		probe.reclaimed(7);

		expect(logger.lines).toEqual([
			{ level: "info", event: "flume.broker.reclaimed", fields: { count: 7 } },
		]);
	});

	it("logs a reclaim failure at error with the reason", () => {
		probe.reclaimFailed(new Error("reclaim blew up"));

		expect(logger.lines).toEqual([
			{
				level: "error",
				event: "flume.broker.reclaim_failed",
				fields: { error: "reclaim blew up" },
			},
		]);
	});

	it("logs reaped resources at info with the counts", () => {
		probe.reaped({ groupsDestroyed: 2, streamsTrimmed: 3 });

		expect(logger.lines).toEqual([
			{
				level: "info",
				event: "flume.broker.reaped",
				fields: { groupsDestroyed: 2, streamsTrimmed: 3 },
			},
		]);
	});

	it("logs a reap failure at warn with the reason", () => {
		probe.reapFailed(new Error("reap blew up"));

		expect(logger.lines[0]).toEqual({
			level: "warn",
			event: "flume.broker.reap_failed",
			fields: { error: "reap blew up" },
		});
	});

	it("logs a heartbeat failure at warn with the reason", () => {
		probe.heartbeatFailed(new Error("hb blew up"));

		expect(logger.lines[0]).toEqual({
			level: "warn",
			event: "flume.broker.heartbeat_failed",
			fields: { error: "hb blew up" },
		});
	});

	it("logs a consumer stop at error with the stream, group and reason", () => {
		probe.consumerStopped({
			stream: "orders",
			group: "orders__workers",
			error: new Error("boom"),
		});

		expect(logger.lines).toEqual([
			{
				level: "error",
				event: "flume.broker.consumer_stopped",
				fields: {
					stream: "orders",
					group: "orders__workers",
					error: "boom",
				},
			},
		]);
	});

	it("logs a consumer stall at error with the stream, group, count and reason", () => {
		probe.consumerStalled({
			stream: "orders",
			group: "orders__workers",
			consecutive: 2,
			error: new Error("NOPERM"),
		});

		expect(logger.lines).toEqual([
			{
				level: "error",
				event: "flume.broker.consumer_stalled",
				fields: {
					stream: "orders",
					group: "orders__workers",
					consecutive: 2,
					error: "NOPERM",
				},
			},
		]);
	});

	it("logs a redrive at info with the result", () => {
		probe.redrove({ redriven: 4, skipped: 1 });

		expect(logger.lines).toEqual([
			{
				level: "info",
				event: "flume.broker.redrove",
				fields: { redriven: 4, skipped: 1 },
			},
		]);
	});

	it("stringifies a non-Error failure reason", () => {
		probe.reclaimFailed("plain string reason");

		expect(logger.lines[0].fields.error).toBe("plain string reason");
	});
});
