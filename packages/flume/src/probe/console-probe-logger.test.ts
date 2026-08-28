import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConsoleProbeLogger } from "./console-probe-logger";

describe(ConsoleProbeLogger, () => {
	let originalWarn: typeof console.warn;
	let calls: string[];

	beforeEach(() => {
		originalWarn = console.warn;
		calls = [];
		console.warn = (line: string) => {
			calls.push(line);
		};
	});

	afterEach(() => {
		console.warn = originalWarn;
	});

	it("logs a warning through console.warn as a JSON line", () => {
		new ConsoleProbeLogger().warn("flume.x", { a: 1 });

		expect(calls).toEqual([JSON.stringify({ event: "flume.x", a: 1 })]);
	});
});
