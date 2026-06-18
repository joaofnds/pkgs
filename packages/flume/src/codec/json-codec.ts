import { Bytes, Codec } from "../ports/codec";

// Core default codec. Encodes values as UTF-8 JSON bytes. For arbitrary binary
// payloads (msgpack, protobuf) supply a binary Codec instead — the envelope wire
// is binary-clean regardless.
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
