import { Status } from "@nats-io/nats-core";
import { beforeEach, describe, expect, it } from "vitest";
import { ConnectionLifecycle, StatusEmitter } from "./connection-lifecycle";
import { RecordingBrokerProbe } from "./test-support/recording-broker-probe";

class FakeConnection implements StatusEmitter {
	constructor(private readonly events: Status[]) {}

	async *status(): AsyncIterable<Status> {
		for (const event of this.events) yield event;
	}
}

const SERVER = "nats://localhost:4222";

describe(ConnectionLifecycle, () => {
	let probe: RecordingBrokerProbe;

	beforeEach(() => {
		probe = new RecordingBrokerProbe();
	});

	it("reports disconnected on a disconnect status", async () => {
		await new ConnectionLifecycle(probe).watch(
			new FakeConnection([{ type: "disconnect", server: SERVER }]),
		);

		expect(probe.disconnectedCount).toBe(1);
		expect(probe.reconnectedCount).toBe(0);
	});

	it("reports reconnected on a reconnect status", async () => {
		await new ConnectionLifecycle(probe).watch(
			new FakeConnection([{ type: "reconnect", server: SERVER }]),
		);

		expect(probe.reconnectedCount).toBe(1);
		expect(probe.disconnectedCount).toBe(0);
	});

	it("ignores statuses that are not connection transitions", async () => {
		await new ConnectionLifecycle(probe).watch(
			new FakeConnection([{ type: "update" }, { type: "ldm", server: SERVER }]),
		);

		expect(probe.disconnectedCount).toBe(0);
		expect(probe.reconnectedCount).toBe(0);
	});
});
