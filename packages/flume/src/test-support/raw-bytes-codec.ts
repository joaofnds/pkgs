import { Bytes, Codec } from "../ports/codec";

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
