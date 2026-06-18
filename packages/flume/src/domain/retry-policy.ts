export class InvalidRetryPolicyError extends Error {
	constructor(maxAttempts: number) {
		super(`maxAttempts must be at least 1, got ${maxAttempts}`);
		this.name = "InvalidRetryPolicyError";
	}
}

// The retry contract is attempt-count only in v1. Retry *timing* is broker
// config (reclaim minIdleTime/interval), not a per-policy promise — the broker
// port has no delay primitive, so promising a backoff curve here would be a
// contract the port can't keep.
export class RetryPolicy {
	readonly maxAttempts: number;

	constructor(props: { maxAttempts: number }) {
		if (props.maxAttempts < 1) {
			throw new InvalidRetryPolicyError(props.maxAttempts);
		}
		this.maxAttempts = props.maxAttempts;
	}

	// True once a delivery count has gone past the allowed attempts — the
	// dead-letter trigger. count 1 (fresh delivery) never exhausts, so a fresh
	// delivery always attempts the handler.
	exhaustedBy(deliveryCount: number): boolean {
		return deliveryCount > this.maxAttempts;
	}
}
