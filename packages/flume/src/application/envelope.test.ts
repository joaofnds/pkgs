import { describe, expect, it } from "vitest";
import {
	Envelope,
	TruncatedEnvelopeError,
	UnsupportedEnvelopeVersionError,
} from "../index";

describe(Envelope, () => {
	it("round-trips version, dispatchedAt, and payload", () => {
		const dispatchedAt = new Date("2026-06-18T00:00:00.000Z");
		const payload = new Uint8Array([1, 2, 3]);

		const parsed = Envelope.parse(
			new Envelope({ dispatchedAt, payload }).toBytes(),
		);

		expect(parsed.version).toBe(1);
		expect(parsed.dispatchedAt).toEqual(dispatchedAt);
		expect(parsed.payload).toEqual(payload);
	});

	it("preserves a non-UTF-8 payload byte for byte", () => {
		const payload = new Uint8Array([0xff, 0xfe, 0x00, 0x10, 0x7f, 0x80]);

		const parsed = Envelope.parse(
			new Envelope({ dispatchedAt: new Date(0), payload }).toBytes(),
		);

		expect(parsed.payload).toEqual(payload);
	});

	it("round-trips a header-only frame with an empty payload", () => {
		const dispatchedAt = new Date("2026-06-18T00:00:00.000Z");

		const parsed = Envelope.parse(
			new Envelope({ dispatchedAt, payload: new Uint8Array() }).toBytes(),
		);

		expect(parsed.version).toBe(1);
		expect(parsed.dispatchedAt).toEqual(dispatchedAt);
		expect(parsed.payload).toEqual(new Uint8Array());
	});

	it("defaults the version to 1", () => {
		const envelope = new Envelope({
			dispatchedAt: new Date(0),
			payload: new Uint8Array(),
		});

		expect(envelope.version).toBe(1);
	});

	it("rejects a frame too short to hold the header", () => {
		expect(() => Envelope.parse(new Uint8Array([1, 0, 0]))).toThrow(
			TruncatedEnvelopeError,
		);
	});

	it("rejects an unsupported version", () => {
		const frame = new Envelope({
			dispatchedAt: new Date(0),
			payload: new Uint8Array(),
		}).toBytes();
		frame[0] = 2;

		expect(() => Envelope.parse(frame)).toThrow(
			UnsupportedEnvelopeVersionError,
		);
	});
});
