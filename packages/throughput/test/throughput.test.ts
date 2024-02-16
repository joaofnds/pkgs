import { describe, expect, test } from "@jest/globals";
import { Throughput } from "../src";
import { FakeTicker } from "./faker.ticker";

describe(Throughput, () => {
	test.each([
		{
			probeSize: 10,
			probeInterval: 1000,

			ticks: 10,
			hitsPerTick: 10,
			tickInterval: 1000,

			expectedTPS: 10,
		},
		{
			probeSize: 10,
			probeInterval: 100,

			ticks: 100,
			hitsPerTick: 100,
			tickInterval: 100,

			expectedTPS: 1000,
		},
		{
			probeSize: 60,
			probeInterval: 1000,

			ticks: 600,
			hitsPerTick: 150,
			tickInterval: 100,

			expectedTPS: 150,
		},
	])(
		"%p",
		async ({
			probeSize,
			probeInterval,
			tickInterval,
			hitsPerTick,
			ticks,
			expectedTPS,
		}) => {
			let now = Date.now();
			const nowfn = () => {
				now += tickInterval;
				return now;
			};
			const fakeTicker = new FakeTicker();
			const throughput = new Throughput(
				probeSize,
				probeInterval,
				fakeTicker,
				nowfn,
			);
			throughput.start();

			for (let i = 0; i < ticks; i++) {
				for (let j = 0; j < hitsPerTick; j++) {
					throughput.hit();
				}
				fakeTicker.tick();
			}

			expect(throughput.perSecond()).toBe(expectedTPS);
			throughput.stop();
		},
	);
});
