import { Bytes } from "../ports/codec";
import { HEADER_BYTES, VERSION } from "./envelope-format";
import { TruncatedEnvelopeError } from "./truncated-envelope-error";
import { UnsupportedEnvelopeVersionError } from "./unsupported-envelope-version-error";

// The versioned wire envelope: { v, dispatchedAt, payload }. Core-owned framing,
// distinct from the swappable payload Codec — the version field keeps future
// additions (schema id, trace context) non-breaking. Binary framing (not JSON)
// so an arbitrary-byte payload survives the round-trip verbatim.
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
