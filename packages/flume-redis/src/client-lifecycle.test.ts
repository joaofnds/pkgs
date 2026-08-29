import { beforeEach, describe, expect, it } from "vitest";
import { ClientLifecycle, LifecycleEmitter } from "./client-lifecycle";
import { RecordingBrokerProbe } from "./test-support/recording-broker-probe";

type Listener = (error: unknown) => void;

class FakeClient implements LifecycleEmitter {
	isOpen = true;
	private readonly listeners = new Map<string, Listener[]>();

	on(event: "ready" | "reconnecting" | "error", listener: Listener): this {
		const existing = this.listeners.get(event) ?? [];
		existing.push(listener);
		this.listeners.set(event, existing);
		return this;
	}

	emit(event: "ready" | "reconnecting"): void {
		this.fire(event, undefined);
	}

	failTransiently(error: unknown): void {
		this.fire("error", error);
	}

	giveUp(error: unknown): void {
		this.isOpen = false;
		this.fire("error", error);
	}

	private fire(event: string, error: unknown): void {
		for (const listener of this.listeners.get(event) ?? []) listener(error);
	}
}

describe(ClientLifecycle, () => {
	let probe: RecordingBrokerProbe;
	let client: FakeClient;
	let lifecycle: ClientLifecycle;

	beforeEach(() => {
		probe = new RecordingBrokerProbe();
		client = new FakeClient();
		lifecycle = new ClientLifecycle(probe);
		lifecycle.watch(client);
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

	it("reports a connection abandoned when the client gives up", () => {
		const cause = new Error("gave up reconnecting");

		client.emit("ready");
		client.giveUp(cause);

		expect(probe.connectionAbandonedCalls).toEqual([cause]);
	});

	it("reports nothing for a reconnect before the first ready", () => {
		client.emit("reconnecting");

		expect(probe.disconnectedCount).toBe(0);
	});

	it("reports nothing for a give-up before the first ready", () => {
		client.giveUp(new Error("gave up on the initial connect"));

		expect(probe.connectionAbandonedCalls).toEqual([]);
	});

	it("reports nothing for an error the client will retry", () => {
		client.emit("ready");
		client.failTransiently(new Error("socket closed unexpectedly"));

		expect(probe.connectionAbandonedCalls).toEqual([]);
	});

	it("reports a connection abandoned at most once", () => {
		client.emit("ready");
		client.giveUp(new Error("first"));
		client.giveUp(new Error("second"));

		expect(probe.connectionAbandonedCalls).toEqual([new Error("first")]);
	});

	it("reports disconnected on reconnecting", () => {
		client.emit("ready");
		client.emit("reconnecting");

		expect(probe.disconnectedCount).toBe(1);
	});

	it("reports one disconnect however many times the client retries", () => {
		client.emit("ready");
		client.emit("reconnecting");
		client.emit("reconnecting");
		client.emit("reconnecting");
		client.emit("ready");

		expect(probe.disconnectedCount).toBe(1);
		expect(probe.reconnectedCount).toBe(1);
	});

	it("reports nothing after it stops watching", () => {
		client.emit("ready");
		lifecycle.stop();

		client.emit("reconnecting");
		client.giveUp(new Error("gave up after the watcher stopped"));

		expect(probe.disconnectedCount).toBe(0);
		expect(probe.connectionAbandonedCalls).toEqual([]);
	});
});
