import { beforeEach, describe, expect, it } from "vitest";
import { ClientLifecycle, LifecycleEmitter } from "./client-lifecycle";
import { RecordingBrokerProbe } from "./test-support/recording-broker-probe";

type Listener = () => void;

class FakeClient implements LifecycleEmitter {
	private readonly listeners = new Map<string, Listener[]>();

	on(event: "ready" | "reconnecting", listener: Listener): this {
		const existing = this.listeners.get(event) ?? [];
		existing.push(listener);
		this.listeners.set(event, existing);
		return this;
	}

	emit(event: "ready" | "reconnecting"): void {
		for (const listener of this.listeners.get(event) ?? []) listener();
	}
}

describe(ClientLifecycle, () => {
	let probe: RecordingBrokerProbe;
	let client: FakeClient;

	beforeEach(() => {
		probe = new RecordingBrokerProbe();
		client = new FakeClient();
		new ClientLifecycle(probe).watch(client);
	});

	it("reports connected on the first ready", () => {
		client.emit("ready");

		expect(probe.connectedCount).toBe(1);
		expect(probe.reconnectedCount).toBe(0);
	});

	it("reports reconnected on a ready after the first", () => {
		client.emit("ready");
		client.emit("reconnecting");
		client.emit("ready");

		expect(probe.connectedCount).toBe(1);
		expect(probe.reconnectedCount).toBe(1);
	});

	it("reports disconnected on reconnecting", () => {
		client.emit("ready");
		client.emit("reconnecting");

		expect(probe.disconnectedCount).toBe(1);
	});
});
