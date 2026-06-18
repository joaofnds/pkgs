// Runtime-neutral byte string (Node + edge), binary-clean for msgpack/protobuf.
// Adapters convert at their edge (Redis ↔ Buffer/string).
export type Bytes = Uint8Array;

// The serialization port. JSON by default; binary codecs drop in unchanged.
export interface Codec {
	encode(value: unknown): Bytes;
	decode(body: Bytes): unknown;
}
