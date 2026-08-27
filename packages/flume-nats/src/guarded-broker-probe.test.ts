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
		const stopped = new Error("stopped");

		probe.connected();
		probe.disconnected();
		probe.reconnected();
		probe.deliveryFailed(new Error("deliver boom"));
		probe.consumerStopped({
			subject: "flume.orders",
			durable: "orders__workers",
			error: stopped,
		});

		expect(delegate.connectedCount).toBe(1);
		expect(delegate.disconnectedCount).toBe(1);
		expect(delegate.reconnectedCount).toBe(1);
		expect(delegate.deliveryFailures).toHaveLength(1);
		expect(delegate.consumerStoppedCalls).toEqual([
			{
				subject: "flume.orders",
				durable: "orders__workers",
				error: stopped,
			},
		]);
	});

	it("swallows errors thrown by the delegate", () => {
		const throwing = new GuardedBrokerProbe(new ThrowingBrokerProbe());

		expect(() => throwing.connected()).not.toThrow();
		expect(() => throwing.disconnected()).not.toThrow();
		expect(() => throwing.reconnected()).not.toThrow();
		expect(() => throwing.deliveryFailed(new Error("x"))).not.toThrow();
		expect(() =>
			throwing.consumerStopped({
				subject: "flume.orders",
				durable: "orders__workers",
				error: new Error("x"),
			}),
		).not.toThrow();
	});
});
