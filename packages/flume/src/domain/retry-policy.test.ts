import { describe, expect, it } from "vitest";
import { InvalidRetryPolicyError, RetryPolicy } from "../index";

describe(RetryPolicy, () => {
	describe("exhaustedBy", () => {
		it.each([
			{ maxAttempts: 1, deliveryCount: 1, exhausted: false },
			{ maxAttempts: 1, deliveryCount: 2, exhausted: true },
			{ maxAttempts: 2, deliveryCount: 1, exhausted: false },
			{ maxAttempts: 2, deliveryCount: 2, exhausted: false },
			{ maxAttempts: 2, deliveryCount: 3, exhausted: true },
		])("maxAttempts $maxAttempts is exhausted by delivery $deliveryCount → $exhausted", ({
			maxAttempts,
			deliveryCount,
			exhausted,
		}) => {
			expect(new RetryPolicy({ maxAttempts }).exhaustedBy(deliveryCount)).toBe(
				exhausted,
			);
		});
	});

	it("rejects a policy that allows fewer than one attempt", () => {
		expect(() => new RetryPolicy({ maxAttempts: 0 })).toThrow(
			InvalidRetryPolicyError,
		);
	});
});
