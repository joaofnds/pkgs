import { describe, expect, it } from "vitest";
import { blockingCommandTimeout } from "./clients";

describe("blockingCommandTimeout", () => {
	it.each([0, 50, 100, 5000, 30000])("stays above a %dms block", (blockMs) => {
		expect(blockingCommandTimeout(blockMs)).toBeGreaterThan(blockMs);
	});
});
