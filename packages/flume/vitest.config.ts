import { defineConfig } from "vitest/config";

// The core has no decorators, so no unplugin-swc / metadata setup is needed.
// M2 adds Redis integration tests under test/ that talk to real Redis (docker
// compose, port 6381): they block on XREADGROUP and wait out reclaim intervals,
// so they need a longer timeout than the unit suite.
export default defineConfig({
	test: {
		environment: "node",
		testTimeout: 20000,
		hookTimeout: 30000,
	},
});
