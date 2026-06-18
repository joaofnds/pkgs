import { EnvelopeError } from "./envelope-error";
import { HEADER_BYTES } from "./envelope-format";

export class TruncatedEnvelopeError extends EnvelopeError {
	constructor(length: number) {
		super(`envelope is ${length} bytes, need at least ${HEADER_BYTES}`);
		this.name = "TruncatedEnvelopeError";
	}
}
