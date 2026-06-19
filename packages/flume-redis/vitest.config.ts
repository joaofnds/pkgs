import { defineConfig } from "vitest/config";

// The Redis integration tests under test/ talk to real Redis (docker compose,
// port 6381): they block on XREADGROUP and wait out reclaim intervals, so they
// need a longer timeout than a pure unit suite.
export default defineConfig({
	test: {
		environment: "node",
		testTimeout: 20000,
		hookTimeout: 30000,
	},
});
