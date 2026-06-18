import { describe, expect, it } from "vitest";
import { DeliveryMode, RetryPolicy, Subscription, Topic } from "../index";
import { RecordingHandler } from "../test-support";

describe(Subscription, () => {
	function subscription(topicName: string, name: string): Subscription {
		return new Subscription({
			topic: new Topic(topicName),
			name,
			handler: new RecordingHandler(),
			retry: new RetryPolicy({ maxAttempts: 1 }),
			delivery: DeliveryMode.Competing,
		});
	}

	it("defaults startFrom to new", () => {
		expect(subscription("t", "n").startFrom).toBe("new");
	});

	describe("key", () => {
		it("matches another subscription with the same topic and name", () => {
			expect(subscription("t", "n").key()).toBe(subscription("t", "n").key());
		});

		it("differs when the name differs", () => {
			expect(subscription("t", "a").key()).not.toBe(
				subscription("t", "b").key(),
			);
		});

		it("differs when the topic differs", () => {
			expect(subscription("a", "n").key()).not.toBe(
				subscription("b", "n").key(),
			);
		});

		it("does not collide across a separator-ambiguous boundary", () => {
			expect(subscription("a", "b c").key()).not.toBe(
				subscription("a b", "c").key(),
			);
		});
	});
});
