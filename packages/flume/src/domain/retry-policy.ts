import { InvalidRetryPolicyError } from "./invalid-retry-policy-error";

export class RetryPolicy {
	readonly maxAttempts: number;

	constructor(props: { maxAttempts: number }) {
		if (!Number.isInteger(props.maxAttempts) || props.maxAttempts < 1) {
			throw new InvalidRetryPolicyError(props.maxAttempts);
		}
		this.maxAttempts = props.maxAttempts;
	}

	exhaustedBy(deliveryCount: number): boolean {
		return deliveryCount > this.maxAttempts;
	}
}
