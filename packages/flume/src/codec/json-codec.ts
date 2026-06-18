import { Bytes, Codec } from "../ports/codec";

export class JsonCodec implements Codec {
	private readonly encoder = new TextEncoder();
	private readonly decoder = new TextDecoder();

	encode(value: unknown): Bytes {
		return this.encoder.encode(JSON.stringify(value));
	}

	decode(body: Bytes): unknown {
		return JSON.parse(this.decoder.decode(body));
	}
}
