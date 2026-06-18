import { describe, expect, it } from "vitest";
import { JsonCodec } from "../index";

describe(JsonCodec, () => {
	const codec = new JsonCodec();

	it("encodes to a Uint8Array", () => {
		expect(codec.encode({ a: 1 })).toBeInstanceOf(Uint8Array);
	});

	it("round-trips an object", () => {
		expect(codec.decode(codec.encode({ a: 1, b: ["x"] }))).toEqual({
			a: 1,
			b: ["x"],
		});
	});

	it("round-trips multibyte UTF-8 content", () => {
		const value = { emoji: "🦴", accents: "áéíõ" };

		expect(codec.decode(codec.encode(value))).toEqual(value);
	});
});
