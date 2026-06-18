import { describe, expect, it } from "vitest";
import { InvalidBroadcastOptionsError, resolveOptions } from "./options";

const redis = { url: "redis://localhost:6381" };

describe("resolveOptions", () => {
	it("defaults consumerName and instanceId to the same host:pid identity", () => {
		const resolved = resolveOptions({ redis });

		expect(resolved.consumerName).toBe(resolved.instanceId);
		expect(resolved.instanceId).toContain(String(process.pid));
	});

	it("rejects a broadcast TTL that is not above the heartbeat interval", () => {
		expect(() =>
			resolveOptions({
				redis,
				broadcast: { heartbeatInterval: 1000, heartbeatTtl: 1000 },
			}),
		).toThrow(InvalidBroadcastOptionsError);
	});

	it("accepts a broadcast TTL safely above the interval", () => {
		expect(() =>
			resolveOptions({
				redis,
				broadcast: { heartbeatInterval: 1000, heartbeatTtl: 3000 },
			}),
		).not.toThrow();
	});
});
