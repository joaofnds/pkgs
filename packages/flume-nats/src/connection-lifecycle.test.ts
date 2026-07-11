import { Events } from "nats";
import { beforeEach, describe, expect, it } from "vitest";
import { ConnectionLifecycle, StatusEmitter } from "./connection-lifecycle";
import { RecordingBrokerProbe } from "./test-support/recording-broker-probe";

class FakeConnection implements StatusEmitter {
	constructor(private readonly events: { type: string }[]) {}

	async *status(): AsyncIterable<{ type: string }> {
		for (const event of this.events) yield event;
	}
}

describe(ConnectionLifecycle, () => {
	let probe: RecordingBrokerProbe;

	beforeEach(() => {
		probe = new RecordingBrokerProbe();
	});

	it("reports disconnected on a disconnect status", async () => {
		await new ConnectionLifecycle(probe).watch(
			new FakeConnection([{ type: Events.Disconnect }]),
		);

		expect(probe.disconnectedCount).toBe(1);
		expect(probe.reconnectedCount).toBe(0);
	});

	it("reports reconnected on a reconnect status", async () => {
		await new ConnectionLifecycle(probe).watch(
			new FakeConnection([{ type: Events.Reconnect }]),
		);

		expect(probe.reconnectedCount).toBe(1);
		expect(probe.disconnectedCount).toBe(0);
	});

	it("ignores statuses that are not connection transitions", async () => {
		await new ConnectionLifecycle(probe).watch(
			new FakeConnection([{ type: Events.Update }, { type: Events.LDM }]),
		);

		expect(probe.disconnectedCount).toBe(0);
		expect(probe.reconnectedCount).toBe(0);
	});
});
