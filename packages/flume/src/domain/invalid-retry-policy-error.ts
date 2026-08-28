export class InvalidRetryPolicyError extends Error {
	constructor(maxAttempts: number) {
		super(
			`maxAttempts must be a finite integer of at least 1, got ${maxAttempts}`,
		);
		this.name = "InvalidRetryPolicyError";
	}
}
