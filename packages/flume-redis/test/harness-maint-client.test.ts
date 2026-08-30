import { describe, expect, it } from "vitest";
import { BrokerHarness } from "./support/harness";

describe("harness maint client", () => {
	// An 'error' on an EventEmitter with no listener is an uncaught exception that
	// kills the vitest worker. node-redis emits one on every socket fault.
	it("has a listener for the socket faults node-redis emits", async () => {
		const harness = await BrokerHarness.start();

		expect(harness.maint.listenerCount("error")).toBeGreaterThan(0);
		expect(() =>
			harness.maint.emit("error", new Error("Socket closed unexpectedly")),
		).not.toThrow();

		await harness.stop();
	});
});
