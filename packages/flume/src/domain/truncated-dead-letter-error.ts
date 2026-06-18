export class TruncatedDeadLetterError extends Error {
	constructor(length: number) {
		super(`dead-letter frame is ${length} bytes, too short for its header`);
		this.name = "TruncatedDeadLetterError";
	}
}
