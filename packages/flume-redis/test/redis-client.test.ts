import { uniqueTopic } from "@joaofnds/flume-tck";
import {
	ClientClosedError,
	DisconnectsClientError,
	createClient,
} from "redis";
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

const REDIS_URL = "redis://localhost:6381";
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

	// Guards the same four connect() sites, from the other side: their await is
	// both what trusts the settlement and the only handler on the promise.
	//
	// consumer-loop.ts:159-162 already carries the conclusion in a comment —
	// connect() resolves on a client destroyed mid-connect, so isOpen is what
	// says the replacement succeeded. These two pin why a resolved connect() is
	// not evidence: one address, two destroy() timings, opposite settlements,
	// isOpen false either way.
	//
	// The discriminator is where destroy() lands in the retry cycle, not the
	// address. Two ways to get these wrong, both probed. Moving a destroy() into
	// a 'reconnecting' handler body inverts the outcome: awaiting the event then
	// destroying rejects, while destroying inside the handler resolves, one
	// microtask apart. And waiting with node:events' once(client, ...) makes the
	// run crash rather than reject: that helper binds its own 'error' listener
	// which removes itself when it fires, leaving the client bare for the next
	// socket fault. Wait on the client's own once() instead.
	describe("connect() settlement after destroy()", () => {
		it("rejects when destroy() lands right after the first 'reconnecting'", async () => {
			const client = createWriteClient({
				url: REFUSED_URL,
				socket: { connectTimeout: 200 },
			});
			const connecting = client.connect();

			await new Promise((reconnecting) => {
				client.once("reconnecting", reconnecting);
			});
			client.destroy();

			await expect(connecting).rejects.toThrow();
			expect(client.isOpen).toBe(false);
		});

		it("resolves when destroy() lands well after the second 'reconnecting'", async () => {
			const client = createWriteClient({
				url: REFUSED_URL,
				socket: { connectTimeout: 200 },
			});
			const connecting = client.connect();

			let reconnects = 0;
			await new Promise<void>((resolve) => {
				client.on("reconnecting", () => {
					reconnects++;
					if (reconnects === 2) resolve();
				});
			});
			await new Promise((resolve) => setTimeout(resolve, 50));
			client.destroy();

			// connect() resolves with the client itself, so a truthy resolution
			// value is not evidence of a usable connection either.
			await expect(connecting).resolves.toBe(client);
			expect(client.isOpen).toBe(false);
		});
	});

	// Guards the same four connect() sites, whose await is the only handler on
	// the promise. destroy() does not abort an in-flight connect(): the promise
	// outlives the call by a wide margin and can still reject, so a
	// `void client.connect()` anywhere would leave an unhandled rejection that
	// takes the process down.
	it("leaves an in-flight connect() unsettled across destroy(), so the promise still needs a handler", async () => {
		const client = createWriteClient({
			url: REFUSED_URL,
			socket: { connectTimeout: 200 },
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

		let reconnects = 0;
		await new Promise<void>((second) => {
			client.on("reconnecting", () => {
				reconnects++;
				if (reconnects === 2) second();
			});
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		client.destroy();

		// Synchronously, then across a microtask drain and a macrotask turn, so
		// the claim is about the library and not about scheduling order.
		expect(settled).toBe(false);
		await new Promise((resolve) => setImmediate(resolve));
		expect(settled).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(settled).toBe(false);

		await connecting;
		expect(settled).toBe(true);
	});

	// Guards ConsumerLoop.stopsConsumer's classification (consumer-loop.ts:208).
	// The two errors a stop produces are not the same class, and the difference
	// decides whether a consumer is stopped or kept: a DisconnectsClientError is
	// not a ClientClosedError, so a destroy() flume itself issued does not route
	// through the stop branch. If a bump collapsed the two, stopsConsumer would
	// permanently stop consumers that are recoverable.
	//
	// Both classes carry name === "Error", so this asserts with instanceof; a
	// name comparison passes for either and pins nothing.
	it("rejects a blocking read with DisconnectsClientError on destroy(), while the next command rejects ClientClosedError", async () => {
		const client = createReadClient({ url: REDIS_URL });
		await client.connect();

		const stream = uniqueTopic();
		const group = uniqueTopic("group");
		await client.xGroupCreate(stream, group, "$", { MKSTREAM: true });

		const reading = client.xReadGroup(
			group,
			"consumer",
			[{ key: stream, id: ">" }],
			{ BLOCK: 0 },
		);
		setTimeout(() => {
			if (client.isOpen) client.destroy();
		}, 300);

		const readError = await reading.then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(readError).toBeInstanceOf(DisconnectsClientError);
		expect(isClientClosedError(readError)).toBe(false);

		const nextError = await client.ping().then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(nextError).toBeInstanceOf(ClientClosedError);
		expect(isClientClosedError(nextError)).toBe(true);
	});
});
