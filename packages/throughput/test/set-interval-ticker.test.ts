import { describe, expect, it } from "@jest/globals";
import { SetIntervalTicker } from "../src";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe(SetIntervalTicker, () => {
	it("calls the function every every X millis", async () => {
		const ticker = new SetIntervalTicker();

		let calls = 1;
		ticker.start(() => calls++, 10);

		await sleep(100);
		ticker.stop();

		expect(calls).toBe(10);
	});

	it("stops calling the function after stop()", async () => {
		const ticker = new SetIntervalTicker();

		let calls = 1;
		ticker.start(() => calls++, 10);

		await sleep(50);
		ticker.stop();
		expect(calls).toBe(5);

		await sleep(50);
		expect(calls).toBe(5);
	});
});
