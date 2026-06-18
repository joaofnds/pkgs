import { Bytes, Codec } from "../ports/codec";

// Passthrough binary codec: payload is raw Bytes in and out, so a test can prove
// the wire is binary-clean for non-UTF-8 content end to end.
export class RawBytesCodec implements Codec {
	encode(value: unknown): Bytes {
		if (!(value instanceof Uint8Array)) {
			throw new Error("RawBytesCodec only encodes Uint8Array");
		}
		return value;
	}

	decode(body: Bytes): unknown {
		return body;
	}
}
