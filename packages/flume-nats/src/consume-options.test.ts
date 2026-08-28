import { describe, expect, it } from "vitest";
import {
	consumeOptionsFor,
	EXPIRES_MS,
	IDLE_HEARTBEAT_MS,
} from "./consume-options";

describe(consumeOptionsFor, () => {
	it.for([
		{ concurrency: 1, maxMessages: 2, thresholdMessages: 1 },
		{ concurrency: 2, maxMessages: 2, thresholdMessages: 1 },
		{ concurrency: 3, maxMessages: 3, thresholdMessages: 2 },
		{ concurrency: 4, maxMessages: 4, thresholdMessages: 3 },
		{ concurrency: 10, maxMessages: 10, thresholdMessages: 8 },
		{ concurrency: 64, maxMessages: 64, thresholdMessages: 48 },
	])(
		"derives max_messages $maxMessages and threshold_messages $thresholdMessages for concurrency $concurrency",
		({ concurrency, maxMessages, thresholdMessages }) => {
			const options = consumeOptionsFor(concurrency);

			expect(options).toMatchObject({
				max_messages: maxMessages,
				threshold_messages: thresholdMessages,
				expires: EXPIRES_MS,
				idle_heartbeat: IDLE_HEARTBEAT_MS,
			});
		},
	);

	it.for(
		Array.from({ length: 64 }, (_, i) => i + 1).concat(Number.MAX_SAFE_INTEGER),
	)(
		"keeps the progress invariant for every concurrency, e.g. %i",
		(concurrency) => {
			const options = consumeOptionsFor(concurrency);

			expect(options.max_messages).toBeGreaterThanOrEqual(2);
			expect(options.threshold_messages).toBeGreaterThanOrEqual(1);
			expect(options.threshold_messages).toBeLessThan(
				options.max_messages as number,
			);
			expect(options.expires).toBe(EXPIRES_MS);
			expect(options.idle_heartbeat).toBe(IDLE_HEARTBEAT_MS);
		},
	);

	it("returns a fresh object on every call", () => {
		expect(consumeOptionsFor(10)).not.toBe(consumeOptionsFor(10));
	});
});
