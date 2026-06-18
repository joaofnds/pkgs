import { describe, expect, it } from "vitest";
import { Topic } from "../index";

describe(Topic, () => {
	it("is equal to another topic with the same name", () => {
		expect(new Topic("user.created").equals(new Topic("user.created"))).toBe(
			true,
		);
	});

	it("differs from a topic with another name", () => {
		expect(new Topic("user.created").equals(new Topic("user.deleted"))).toBe(
			false,
		);
	});
});
