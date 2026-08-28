import { describe, expect, it } from "vitest";
import { MaintenanceSweep } from "./maintenance-sweep";
import { SweepAlreadyStartedError } from "./sweep-already-started-error";

const NEVER_FIRES_MS = 60_000;

describe("MaintenanceSweep", () => {
	it("does not enter the sweep a second time while the first is in flight", async () => {
		const gate = Promise.withResolvers<void>();
		let entered = 0;
		const sweep = new MaintenanceSweep(
			async () => {
				entered += 1;
				await gate.promise;
			},
			ignoreFailure,
			NEVER_FIRES_MS,
		);

		const inFlight = sweep.run();
		await sweep.run();

		expect(entered).toBe(1);
		expect(sweep.skipped).toBe(1);

		gate.resolve();
		await inFlight;
	});

	it("reports a rejected sweep to the reporter", async () => {
		const failure = new Error("sweep failed");
		const reported: unknown[] = [];
		const sweep = new MaintenanceSweep(
			async () => {
				throw failure;
			},
			(error) => reported.push(error),
			NEVER_FIRES_MS,
		);

		await sweep.run();

		expect(reported).toEqual([failure]);
	});

	it("enters the sweep again after a rejection", async () => {
		let entered = 0;
		const sweep = new MaintenanceSweep(
			async () => {
				entered += 1;
				throw new Error("sweep failed");
			},
			ignoreFailure,
			NEVER_FIRES_MS,
		);

		await sweep.run();
		await sweep.run();

		expect(entered).toBe(2);
		expect(sweep.skipped).toBe(0);
	});

	it("refuses a second start", () => {
		const sweep = idleSweep();
		sweep.start();

		expect(() => sweep.start()).toThrow(SweepAlreadyStartedError);

		sweep.stop();
	});

	it("can be started again after stop", () => {
		const sweep = idleSweep();
		sweep.start();
		sweep.stop();

		expect(() => sweep.start()).not.toThrow();

		sweep.stop();
	});
});

function idleSweep(): MaintenanceSweep {
	return new MaintenanceSweep(async () => {}, ignoreFailure, NEVER_FIRES_MS);
}

function ignoreFailure(): void {}
