import { beforeEach, describe, expect, it } from "vitest";
import { GuardedBrokerProbe } from "./guarded-broker-probe";
import { RecordingBrokerProbe } from "./test-support/recording-broker-probe";
import { ThrowingBrokerProbe } from "./test-support/throwing-broker-probe";

describe(GuardedBrokerProbe, () => {
	let delegate: RecordingBrokerProbe;
	let probe: GuardedBrokerProbe;

	beforeEach(() => {
		delegate = new RecordingBrokerProbe();
		probe = new GuardedBrokerProbe(delegate);
	});

	it("forwards every call to the delegate", () => {
		probe.connected();
		probe.disconnected();
		probe.reconnected();
		probe.reclaimed(3);
		probe.reclaimFailed(new Error("reclaim boom"));
		probe.reaped({ groupsDestroyed: 2, streamsTrimmed: 1 });
		probe.reapFailed(new Error("reap boom"));
		probe.heartbeatFailed(new Error("hb boom"));
		probe.redrove({ redriven: 4, skipped: 1 });
		probe.consumerStopped({
			stream: "stream",
			group: "group",
			error: new Error("nogroup"),
		});

		expect(delegate.connectedCount).toBe(1);
		expect(delegate.disconnectedCount).toBe(1);
		expect(delegate.reconnectedCount).toBe(1);
		expect(delegate.reclaimedCounts).toEqual([3]);
		expect(delegate.reclaimFailures).toHaveLength(1);
		expect(delegate.reapedCalls).toEqual([
			{ groupsDestroyed: 2, streamsTrimmed: 1 },
		]);
		expect(delegate.reapFailures).toHaveLength(1);
		expect(delegate.heartbeatFailures).toHaveLength(1);
		expect(delegate.redroveResults).toEqual([{ redriven: 4, skipped: 1 }]);
		expect(delegate.consumerStoppedCalls).toEqual([
			{ stream: "stream", group: "group", error: new Error("nogroup") },
		]);
	});

	it("swallows errors thrown by the delegate", () => {
		const throwing = new GuardedBrokerProbe(new ThrowingBrokerProbe());

		expect(() => throwing.connected()).not.toThrow();
		expect(() => throwing.disconnected()).not.toThrow();
		expect(() => throwing.reconnected()).not.toThrow();
		expect(() => throwing.reclaimed(1)).not.toThrow();
		expect(() => throwing.reclaimFailed(new Error("x"))).not.toThrow();
		expect(() =>
			throwing.reaped({ groupsDestroyed: 1, streamsTrimmed: 1 }),
		).not.toThrow();
		expect(() => throwing.reapFailed(new Error("x"))).not.toThrow();
		expect(() => throwing.heartbeatFailed(new Error("x"))).not.toThrow();
		expect(() => throwing.redrove({ redriven: 0, skipped: 0 })).not.toThrow();
		expect(() =>
			throwing.consumerStopped({
				stream: "stream",
				group: "group",
				error: new Error("x"),
			}),
		).not.toThrow();
	});
});
