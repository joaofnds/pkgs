import { Bytes } from "../ports";

const ID_LENGTH_BYTES = 4;

export class TruncatedDeadLetterError extends Error {
	constructor(length: number) {
		super(`dead-letter frame is ${length} bytes, too short for its header`);
		this.name = "TruncatedDeadLetterError";
	}
}

// A handler's message parked after exhausting its retry policy. The core frames
// the ORIGINAL broker message id alongside the original envelope bytes — the id
// only exists at consume time (it is broker-assigned), so it must be captured
// here, not at dispatch. A redrive utility dedups/re-publishes idempotently on
// `originalId`. Carrying it in the framed body keeps the generic Publisher port
// unchanged: the adapter writes this body as-is, and MAY additionally surface
// `originalId` as a broker field by parsing it — no core change required.
//
// Layout: [idLength u32 BE][originalId utf8][body bytes...]
export class DeadLetter {
	readonly originalId: string;
	readonly body: Bytes;

	constructor(props: { originalId: string; body: Bytes }) {
		this.originalId = props.originalId;
		this.body = props.body;
	}

	toBytes(): Bytes {
		const id = new TextEncoder().encode(this.originalId);
		const frame = new Uint8Array(
			ID_LENGTH_BYTES + id.length + this.body.length,
		);
		new DataView(frame.buffer).setUint32(0, id.length);
		frame.set(id, ID_LENGTH_BYTES);
		frame.set(this.body, ID_LENGTH_BYTES + id.length);
		return frame;
	}

	static parse(bytes: Bytes): DeadLetter {
		if (bytes.length < ID_LENGTH_BYTES) {
			throw new TruncatedDeadLetterError(bytes.length);
		}
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const idEnd = ID_LENGTH_BYTES + view.getUint32(0);
		if (bytes.length < idEnd) {
			throw new TruncatedDeadLetterError(bytes.length);
		}
		return new DeadLetter({
			originalId: new TextDecoder().decode(
				bytes.subarray(ID_LENGTH_BYTES, idEnd),
			),
			body: bytes.slice(idEnd),
		});
	}
}
