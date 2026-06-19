import { defineConfig } from "vitest/config";

// Integration tests talk to a real NATS JetStream server (docker compose, port
// 4223). They wait out redelivery / ack_wait, so they need longer timeouts than
// a unit suite. @joaofnds/flume-tck ships TypeScript source, so vitest must
// transform it rather than externalize it.
export default defineConfig({
	test: {
		environment: "node",
		testTimeout: 20000,
		hookTimeout: 30000,
		server: { deps: { inline: [/@joaofnds\/flume-tck/] } },
	},
});
