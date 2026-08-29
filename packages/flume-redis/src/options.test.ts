import { describe, expect, it } from "vitest";
import {
	InvalidIdleTimeError,
	InvalidRateError,
	InvalidTimeoutError,
} from "./index";
import { InvalidCountError } from "./invalid-count-error";
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
const REJECTED_COUNTS = [0, -1, 1.5];
const REJECTED_TIMEOUTS = [0, -1, 1.5];
const REJECTED_IDLE_TIMES = [-1, 1.5];
const REJECTED_RATES = [-1, Number.NaN, Number.POSITIVE_INFINITY];
const ACCEPTED_RATES = [0, 1.5];

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

	it.each(REJECTED_COUNTS)("rejects readCount of %s", (value) => {
		const thrown = thrownBy(() => resolveOptions({ redis, readCount: value }));

		expect(thrown).toBeInstanceOf(InvalidCountError);
		expect(thrown).toMatchObject({ option: "readCount", value });
	});

	it.each(REJECTED_TIMEOUTS)("rejects readTimeout of %s", (value) => {
		const thrown = thrownBy(() =>
			resolveOptions({ redis, readTimeout: value }),
		);

		expect(thrown).toBeInstanceOf(InvalidTimeoutError);
		expect(thrown).toMatchObject({ option: "readTimeout", value });
	});

	it("accepts the smallest readTimeout that still blocks", () => {
		expect(() => resolveOptions({ redis, readTimeout: 1 })).not.toThrow();
	});

	it.each(REJECTED_IDLE_TIMES)("rejects reclaim.minIdleTime of %s", (value) => {
		const thrown = thrownBy(() =>
			resolveOptions({ redis, reclaim: { minIdleTime: value } }),
		);

		expect(thrown).toBeInstanceOf(InvalidIdleTimeError);
		expect(thrown).toMatchObject({ option: "reclaim.minIdleTime", value });
	});

	it("accepts a reclaim.minIdleTime of zero, which claims anything pending", () => {
		expect(() =>
			resolveOptions({ redis, reclaim: { minIdleTime: 0 } }),
		).not.toThrow();
	});

	it.each(REJECTED_RATES)(
		"rejects reclaim.throughputThreshold of %s",
		(value) => {
			const thrown = thrownBy(() =>
				resolveOptions({ redis, reclaim: { throughputThreshold: value } }),
			);

			expect(thrown).toBeInstanceOf(InvalidRateError);
			expect(thrown).toMatchObject({
				option: "reclaim.throughputThreshold",
				value,
			});
		},
	);

	it.each(ACCEPTED_RATES)(
		"accepts a reclaim.throughputThreshold of %s",
		(value) => {
			expect(() =>
				resolveOptions({ redis, reclaim: { throughputThreshold: value } }),
			).not.toThrow();
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
