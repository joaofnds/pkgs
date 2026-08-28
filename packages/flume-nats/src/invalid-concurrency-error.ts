export class InvalidConcurrencyError extends Error {
	constructor(concurrency: number) {
		super(
			`concurrency must be a safe integer of at least 1, got ${concurrency}`,
		);
		this.name = "InvalidConcurrencyError";
	}
}
