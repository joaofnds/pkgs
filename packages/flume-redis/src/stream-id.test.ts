import { describe, expect, it } from "vitest";
import { compareStreamIds, minStreamId } from "./stream-id";

describe("compareStreamIds", () => {
	it.each([
		{ a: "1-0", b: "2-0", sign: -1 },
		{ a: "2-0", b: "1-0", sign: 1 },
		{ a: "5-0", b: "5-0", sign: 0 },
		{ a: "5-1", b: "5-2", sign: -1 },
		{ a: "5-2", b: "5-1", sign: 1 },
		{ a: "10-0", b: "9-999", sign: 1 },
		{ a: "9007199254740993-0", b: "9007199254740992-0", sign: 1 },
	])("compares $a vs $b → $sign", ({ a, b, sign }) => {
		expect(Math.sign(compareStreamIds(a, b))).toBe(sign);
	});

	it("treats a missing sequence as 0", () => {
		expect(Math.sign(compareStreamIds("5", "5-0"))).toBe(0);
		expect(Math.sign(compareStreamIds("5", "5-1"))).toBe(-1);
	});
});

describe("minStreamId", () => {
	it("returns the smallest id by (ms, seq)", () => {
		expect(minStreamId(["10-0", "3-5", "3-2", "100-0"])).toBe("3-2");
	});

	it("returns the only id when the list is a singleton", () => {
		expect(minStreamId(["42-7"])).toBe("42-7");
	});
});
