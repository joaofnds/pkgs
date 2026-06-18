import { EnvelopeError } from "./envelope-error";
import { VERSION } from "./envelope-format";

export class UnsupportedEnvelopeVersionError extends EnvelopeError {
	constructor(readonly version: number) {
		super(`unsupported envelope version ${version}, expected ${VERSION}`);
		this.name = "UnsupportedEnvelopeVersionError";
	}
}
