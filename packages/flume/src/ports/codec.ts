export type Bytes = Uint8Array;

export interface Codec {
	encode(value: unknown): Bytes;
	decode(body: Bytes): unknown;
}
