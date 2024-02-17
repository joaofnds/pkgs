import { describe } from "@jest/globals";
import { assertSameLength, assertSumTo1 } from "./errors";
import { State } from "./state";

describe(State, () => {
	describe("toString", () => {
		it("returns the name", () => {
			const state = new State("state-name");
			expect(state.toString()).toBe(state.name);
		});
	});

	describe("setWeightedNeighbors", () => {
		describe("when the lengths are the same", () => {
			it.each([
				[[], []],
				[["a"], [1]],
				[
					["a", "b"],
					[0.5, 0.5],
				],
			])("does not throw an error", (names, weights) => {
				const state = new State("a");
				const states = names.map((name) => new State(name));
				expect(() => state.setWeightedNeighbors(states, weights)).not.toThrow();
			});
		});

		describe("when the lengths are different", () => {
			it.each([
				[
					[],
					[1],
					[["a"], []],
					[
						["a", "b", [1]],
						[["a"], [0.5, 0.5]],
					],
				],
			])("throws an error", (names, weights) => {
				const state = new State("a");
				const states = names.map((name) => new State(name));
				expect(() => state.setWeightedNeighbors(states, weights)).toThrow(
					"must have the same length",
				);
			});
		});
	});
});
