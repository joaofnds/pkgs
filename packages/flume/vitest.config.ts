import { defineConfig } from "vitest/config";

// The core has no decorators, so no unplugin-swc / metadata setup is needed.
export default defineConfig({
	test: {
		environment: "node",
	},
});
