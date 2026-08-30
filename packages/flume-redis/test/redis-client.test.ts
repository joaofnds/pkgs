import { readFileSync } from "node:fs";
import { uniqueTopic } from "@joaofnds/flume-tck";
import {
	ClientClosedError,
	DisconnectsClientError,
	createClient,
} from "redis";
import { describe, expect, it } from "vitest";
import { createReadClient, createWriteClient } from "../src/clients";
import { isClientClosedError } from "../src/index";

// Learning tests against @redis/client.
//
// These pin the library lifecycle behaviours this package's correctness rests
// on. Each test names, by symbol, the production code it guards. A failure here
// is a notification that the library changed under us, not a test to relax: read
// the named symbol and decide, then change both together.
//
// PROBED_VERSION is the version every claim below was observed against. The
// first test asserts it against what is installed, so a bump reds this file
// until someone re-observes the behaviours and edits the constant in the same
// commit — otherwise the record would quietly start lying.
//
// peerDependencies.redis is ^6.0.0 while this file pins what the workspace
// installs. Green here says nothing about the rest of the range.

const PROBED_VERSION = "6.2.1";
const REDIS_URL = "redis://localhost:6381";
const REFUSED_URL = "redis://localhost:6399";

// A client with no 'error' listener rejects connect() outright and never
// reaches a retry, so waiting on 'reconnecting' would hang for the whole test
// timeout and report nothing. Fail with the cause instead.
function nextReconnect(client: {
	once(event: "reconnecting", listener: () => void): unknown;
}): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() =>
				reject(
					new Error(
						"no 'reconnecting' within 5s: the client is not retrying, which is what a missing 'error' listener does",
					),
				),
			5000,
		);
		client.once("reconnecting", () => {
			clearTimeout(timer);
			resolve();
		});
	});
}

describe("@redis/client", () => {
	// Not a library behaviour: the guard on every claim below. See PROBED_VERSION.
	it("is the version these tests were probed against", () => {
		const manifest = readFileSync(
			require.resolve("redis/package.json"),
			"utf8",
		);
		expect(JSON.parse(manifest).version).toBe(PROBED_VERSION);
	});

	// Guards ignoreSocketErrors, called by createReadClient and createWriteClient.
	// Without that listener a socket fault is an unhandled 'error' event, which
	// kills the host process.
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

	// Guards the isOpen guards before destroy() in ConsumerLoop.abortReadClient
	// and ConsumerLoop.stop. destroy() returns void and throws synchronously —
	// it does not reject — so an unguarded destroy() on an already-stopped
	// consumer would throw where nothing is awaiting it.
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

	// Guards the four connect() sites — RedisStreamsBroker.connect, .consume and
	// .redriveDeadLetters, and ConsumerLoop.replaceReadClient — all of which
	// await connect() and take its settlement as their signal. Against an
	// unreachable server there is no settlement to take, so a caller who needs a
	// bound owns it.
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
	// The window is a lower bound, not proof of "never": it shows connect() still
	// pending and still retrying after 1200ms, while the same address under a
	// listener-less client has already rejected. A future strategy that gave up
	// at, say, five seconds would leave this green, and that is a limit of the
	// test, not a claim about the library.
	it("leaves connect() pending and retrying against a refused address, while a listener-less client rejects", async () => {
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
	// ConsumerLoop.replaceReadClient already carries the conclusion in a
	// comment — connect() resolves on a client destroyed mid-connect, so isOpen
	// is what says the replacement succeeded. These two pin why a resolved connect() is
	// not evidence: one address, two destroy() timings, opposite settlements,
	// isOpen false either way.
	//
	// The discriminator is whether destroy() lands while a connection attempt is
	// in flight or during the backoff between attempts, and nothing else. In
	// flight, RedisSocket's connect catch sees !isOpen and rethrows without
	// scheduling a retry, so connect() rejects; during the backoff, the retry
	// loop's condition goes false and it returns normally, so connect()
	// resolves. Probed across the first, second and third 'reconnecting': the
	// ordinal makes no difference, only the delay after it does.
	//
	// So these wait for a 'reconnecting' purely to reach a known point in the
	// cycle. Destroying immediately after one lands inside the next attempt;
	// waiting first lands in the backoff. ECONNREFUSED arrives in well under a
	// millisecond, so the boundary between the two sits between 1ms and 5ms and
	// the 50ms wait clears it by a wide margin.
	//
	// One way to get this wrong: waiting with node:events' once(client, ...)
	// crashes the run rather than rejecting, because that helper binds its own
	// 'error' listener which removes itself when it fires, leaving the client
	// bare for the next socket fault. Wait on the client's own once() instead.
	describe("connect() settlement after destroy()", () => {
		it("rejects when destroy() lands inside a connection attempt", async () => {
			const client = createWriteClient({
				url: REFUSED_URL,
				socket: { connectTimeout: 200 },
			});
			const connecting = client.connect();

			// Destroying with no wait lands inside the attempt that follows.
			await nextReconnect(client);
			client.destroy();

			await expect(connecting).rejects.toThrow();
			expect(client.isOpen).toBe(false);
		});

		it("resolves when destroy() lands in the backoff between attempts", async () => {
			const client = createWriteClient({
				url: REFUSED_URL,
				socket: { connectTimeout: 200 },
			});
			const connecting = client.connect();

			// The attempt that follows fails in under a millisecond, so 50ms lands
			// in the backoff after it.
			await nextReconnect(client);
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

		await nextReconnect(client);
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

	// Guards ConsumerLoop.stopsConsumer's classification.
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
