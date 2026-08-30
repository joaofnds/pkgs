import { createClient } from "redis";
import { describe, expect, it } from "vitest";
import { createReadClient, createWriteClient } from "../src/clients";

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
});
