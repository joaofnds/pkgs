import { defineConfig } from "vitest/config";

// Pure unit suite — no decorators, no docker, no integration boundary. The
// Redis adapter and its integration tests live in @joaofnds/flume-redis.
export default defineConfig({
	test: {
		environment: "node",
	},
});
