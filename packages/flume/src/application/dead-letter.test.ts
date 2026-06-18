import { describe, expect, it } from "vitest";
import { DeadLetter, TruncatedDeadLetterError } from "../index";

describe(DeadLetter, () => {
	it("round-trips the original id and body", () => {
		const body = new Uint8Array([10, 20, 30]);

		const parsed = DeadLetter.parse(
			new DeadLetter({ originalId: "1718-0", body }).toBytes(),
		);

		expect(parsed.originalId).toBe("1718-0");
		expect(parsed.body).toEqual(body);
	});

	it("preserves a non-UTF-8 body byte for byte", () => {
		const body = new Uint8Array([0xff, 0xfe, 0x00, 0x80]);

		const parsed = DeadLetter.parse(
			new DeadLetter({ originalId: "x", body }).toBytes(),
		);

		expect(parsed.body).toEqual(body);
	});

	it("round-trips an empty body", () => {
		const parsed = DeadLetter.parse(
			new DeadLetter({ originalId: "1", body: new Uint8Array() }).toBytes(),
		);

		expect(parsed.originalId).toBe("1");
		expect(parsed.body).toEqual(new Uint8Array());
	});

	it("rejects a frame too short to hold its header", () => {
		expect(() => DeadLetter.parse(new Uint8Array([0, 0]))).toThrow(
			TruncatedDeadLetterError,
		);
	});

	it("rejects a frame whose declared id length overruns the buffer", () => {
		const frame = new Uint8Array([0, 0, 0, 9, 1, 2]);

		expect(() => DeadLetter.parse(frame)).toThrow(TruncatedDeadLetterError);
	});
});
