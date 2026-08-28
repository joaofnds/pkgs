import { describe, expect, it } from "vitest";
import { InvalidIntervalError } from "./invalid-interval-error";
import {
	InvalidBroadcastOptionsError,
	RedisStreamsBrokerOptions,
	resolveOptions,
} from "./options";

const redis = { url: "redis://localhost:6381" };

const INTERVAL_OPTIONS = [
	{
		option: "reclaim.interval",
		withInterval: (interval: number): RedisStreamsBrokerOptions => ({
			redis,
			reclaim: { interval },
		}),
	},
	{
		option: "reaper.interval",
		withInterval: (interval: number): RedisStreamsBrokerOptions => ({
			redis,
			reaper: { interval },
		}),
	},
	{
		option: "broadcast.heartbeatInterval",
		withInterval: (heartbeatInterval: number): RedisStreamsBrokerOptions => ({
			redis,
			broadcast: { heartbeatInterval },
		}),
	},
];

const REJECTED_INTERVALS = [0, -1, 1.5];

const intervalCases = INTERVAL_OPTIONS.flatMap(({ option, withInterval }) =>
	REJECTED_INTERVALS.map((value) => ({ option, withInterval, value })),
);

describe("resolveOptions", () => {
	it("defaults consumerName and instanceId to the same host:pid identity", () => {
		const resolved = resolveOptions({ redis });

		expect(resolved.consumerName).toBe(resolved.instanceId);
		expect(resolved.instanceId).toContain(String(process.pid));
	});

	it("accepts the default intervals", () => {
		expect(() => resolveOptions({ redis })).not.toThrow();
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

	it.each(intervalCases)(
		"rejects $option of $value",
		({ option, withInterval, value }) => {
			const thrown = thrownBy(() => resolveOptions(withInterval(value)));

			expect(thrown).toBeInstanceOf(InvalidIntervalError);
			expect(thrown).toMatchObject({ option, value });
		},
	);

	it("rejects a zero heartbeat interval before the TTL rule", () => {
		const thrown = thrownBy(() =>
			resolveOptions({
				redis,
				broadcast: { heartbeatInterval: 0, heartbeatTtl: 0 },
			}),
		);

		expect(thrown).toBeInstanceOf(InvalidIntervalError);
	});
});

function thrownBy(resolve: () => unknown): unknown {
	try {
		resolve();
	} catch (error) {
		return error;
	}
	return undefined;
}
