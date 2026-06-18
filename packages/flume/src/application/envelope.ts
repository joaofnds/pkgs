import { Bytes } from "../ports";

const VERSION = 1;
// 1 byte version + 8 bytes dispatchedAt (float64 ms since epoch).
const HEADER_BYTES = 9;

export class EnvelopeError extends Error {}

export class TruncatedEnvelopeError extends EnvelopeError {
	constructor(length: number) {
		super(`envelope is ${length} bytes, need at least ${HEADER_BYTES}`);
		this.name = "TruncatedEnvelopeError";
	}
}

export class UnsupportedEnvelopeVersionError extends EnvelopeError {
	constructor(readonly version: number) {
		super(`unsupported envelope version ${version}, expected ${VERSION}`);
		this.name = "UnsupportedEnvelopeVersionError";
	}
}

// The versioned wire envelope: { v, dispatchedAt, payload }. Core-owned framing,
// distinct from the swappable payload Codec — the version field keeps future
// additions (schema id, trace context) non-breaking. Binary framing (not JSON)
// so an arbitrary-byte payload survives the round-trip verbatim.
//
// Layout: [version: u8][dispatchedAt: f64 BE ms][payload: bytes...]
export class Envelope {
	readonly version: number;
	readonly dispatchedAt: Date;
	readonly payload: Bytes;

	constructor(props: { dispatchedAt: Date; payload: Bytes; version?: number }) {
		this.version = props.version ?? VERSION;
		this.dispatchedAt = props.dispatchedAt;
		this.payload = props.payload;
	}

	toBytes(): Bytes {
		const frame = new Uint8Array(HEADER_BYTES + this.payload.length);
		const view = new DataView(frame.buffer);
		view.setUint8(0, this.version);
		view.setFloat64(1, this.dispatchedAt.getTime());
		frame.set(this.payload, HEADER_BYTES);
		return frame;
	}

	static parse(bytes: Bytes): Envelope {
		if (bytes.length < HEADER_BYTES) {
			throw new TruncatedEnvelopeError(bytes.length);
		}
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const version = view.getUint8(0);
		if (version !== VERSION) {
			throw new UnsupportedEnvelopeVersionError(version);
		}
		return new Envelope({
			version,
			dispatchedAt: new Date(view.getFloat64(1)),
			payload: bytes.slice(HEADER_BYTES),
		});
	}
}
