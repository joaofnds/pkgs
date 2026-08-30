import { ClientClosedError, createClient } from "redis";
import { describe, expect, it } from "vitest";
import { createReadClient, createWriteClient } from "../src/clients";
import { isClientClosedError } from "../src/index";

// Learning tests against @redis/client, probed at version 6.2.1.
//
// These pin the library lifecycle behaviours this package's correctness rests
// on. Each test names the production line it guards. A failure here is a
// notification that the library changed under us, not a test to relax: read the
// named production line and decide, then change both together.
//
// On a redis bump, edit the version above in the same commit that re-greens
// these tests, or the record lies.
//
// peerDependencies.redis is ^6.0.0 while this file pins what the workspace
// installs. Green here says nothing about the rest of the range.

const REFUSED_URL = "redis://localhost:6399";

describe("@redis/client", () => {
	// Guards ignoreSocketErrors (clients.ts:25-27), called by createReadClient
	// at :34 and createWriteClient at :42. Without that listener a socket fault
	// is an unhandled 'error' event, which kills the host process.
	it("leaves a bare client with no 'error' listener, so emitting throws, while both factories bind exactly one", () => {
		const bare = createClient({ url: REFUSED_URL });
		expect(bare.listenerCount("error")).toBe(0);
		expect(() => bare.emit("error", new Error("boom"))).toThrow();

		const read = createReadClient({ url: REFUSED_URL });
		expect(read.listenerCount("error")).toBe(1);
		expect(() => read.emit("error", new Error("boom"))).not.toThrow();

		const write = createWriteClient({ url: REFUSED_URL });
		expect(write.listenerCount("error")).toBe(1);
		expect(() => write.emit("error", new Error("boom"))).not.toThrow();
	});

	// Guards the isOpen guards before destroy() at consumer-loop.ts:149 and :274.
	// destroy() returns void and throws synchronously — it does not reject — so
	// an unguarded destroy() on an already-stopped consumer would throw where
	// nothing is awaiting it.
	it("throws ClientClosedError synchronously when destroy() is called on a client that is not open", () => {
		const client = createClient({ url: REFUSED_URL });

		let thrown: unknown;
		expect(() => {
			try {
				client.destroy();
			} catch (error) {
				thrown = error;
				throw error;
			}
		}).toThrow();
		expect(thrown).toBeInstanceOf(ClientClosedError);
		expect(isClientClosedError(thrown)).toBe(true);
	});

	// Guards the three connect() sites at redis-streams-broker.ts:78, :129, :167
	// and consumer-loop.ts:157, all of which await connect() and take its
	// settlement as their signal. Against an unreachable server there is no
	// settlement to take, so a caller who needs a bound owns it.
	//
	// The never-settling property belongs to the 'error' listener, not to the
	// library: the same address under a listener-less client rejects. That half
	// is asserted here too, so deleting ignoreSocketErrors turns this red.
	//
	// 'error' is counted by reading listenerCount, never by binding a counter: a
	// test-added 'error' listener would itself suppress the rejection, and the
	// test would pass with the factory gutted.
	//
	// The fast cadence is defaultReconnectStrategy's, not connectTimeout's:
	// ECONNREFUSED lands in about a millisecond, so no connect timeout ever
	// applies. The option is insurance for a host that filters port 6399 rather
	// than refusing it, where the 5000ms default would blow the budget.
	it("never settles connect() against a refused address, while a listener-less client rejects", async () => {
		const client = createWriteClient({
			url: REFUSED_URL,
			socket: { connectTimeout: 200 },
		});

		let reconnects = 0;
		client.on("reconnecting", () => {
			reconnects++;
		});

		let settled = false;
		const connecting = client.connect().then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);

		const bare = createClient({
			url: REFUSED_URL,
			socket: { connectTimeout: 200 },
		});
		const bareSettlement = bare.connect().then(
			() => "resolved",
			() => "rejected",
		);

		await new Promise((resolve) => setTimeout(resolve, 1200));

		expect(settled).toBe(false);
		expect(client.isOpen).toBe(true);
		expect(client.isReady).toBe(false);
		expect(client.listenerCount("error")).toBe(1);
		// Counts vary run to run; only their growth is the behaviour.
		expect(reconnects).toBeGreaterThanOrEqual(2);

		expect(await bareSettlement).toBe("rejected");

		if (client.isOpen) client.destroy();
		if (bare.isOpen) bare.destroy();
		await Promise.allSettled([connecting, bareSettlement]);
	});
});
