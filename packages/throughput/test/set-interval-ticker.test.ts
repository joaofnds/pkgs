import { describe, expect, it } from "@jest/globals";
import { SetIntervalTicker } from "../src";

describe(SetIntervalTicker, () => {
	const interval = 10;

	beforeEach(() => jest.useFakeTimers());
	afterEach(() => jest.useRealTimers());

	it("calls the function every every X millis", async () => {
		const ticker = new SetIntervalTicker();

		let calls = 0;
		ticker.start(() => calls++, interval);

		jest.advanceTimersByTime(interval * 10);

		ticker.stop();

		expect(calls).toBe(10);
	});

	it("stops calling the function after stop()", async () => {
		const ticker = new SetIntervalTicker();

		let calls = 0;
		ticker.start(() => calls++, interval);

		jest.advanceTimersByTime(interval * 5);
		ticker.stop();
		expect(calls).toBe(5);

		jest.advanceTimersByTime(interval * 10);
		expect(calls).toBe(5);
	});
});
