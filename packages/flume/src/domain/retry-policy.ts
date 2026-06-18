import { InvalidRetryPolicyError } from "./invalid-retry-policy-error";

// Attempt-count only in v1: retry *timing* is broker reclaim config, not a
// per-policy promise — the broker port has no delay primitive, so a backoff
// curve here would be a contract the port can't keep.
export class RetryPolicy {
	readonly maxAttempts: number;

	constructor(props: { maxAttempts: number }) {
		if (props.maxAttempts < 1) {
			throw new InvalidRetryPolicyError(props.maxAttempts);
		}
		this.maxAttempts = props.maxAttempts;
	}

	// count 1 (fresh delivery) never exhausts, so a fresh delivery always attempts
	// the handler; the dead-letter decision only fires once count exceeds the limit.
	exhaustedBy(deliveryCount: number): boolean {
		return deliveryCount > this.maxAttempts;
	}
}
