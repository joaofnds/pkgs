import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SetIntervalTicker } from "./set-interval-ticker";

describe(SetIntervalTicker, () => {
	const interval = 10;

	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("calls the function every X millis", async () => {
		const ticker = new SetIntervalTicker();

		let calls = 0;
		ticker.start(() => calls++, interval);

		vi.advanceTimersByTime(interval * 10);

		ticker.stop();

		expect(calls).toBe(10);
	});

	it("stops calling the function after stop()", async () => {
		const ticker = new SetIntervalTicker();

		let calls = 0;
		ticker.start(() => calls++, interval);

		vi.advanceTimersByTime(interval * 5);
		ticker.stop();
		expect(calls).toBe(5);

		vi.advanceTimersByTime(interval * 10);
		expect(calls).toBe(5);
	});
});
