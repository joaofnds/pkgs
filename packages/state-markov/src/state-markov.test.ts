import { describe, expect, it } from "@jest/globals";
import { StateMarkov } from "./state-markov";

describe(StateMarkov, () => {
	it("starts with first defined state", () => {
		const a = new StateMarkov({ a: { b: 1 }, b: { a: 1 } });
		expect(a.currentState.name).toBe("a");

		const b = new StateMarkov({ b: { a: 1 }, a: { b: 1 } });
		expect(b.currentState.name).toBe("b");
	});

	describe("when transition to a state is not defined", () => {
		it("does not change to that state", () => {
			const sm = new StateMarkov({
				a: { b: 1 },
				b: { a: 1 },

				c: { a: 0.5, b: 0.5 },
			});

			const states: string[] = [];
			for (let i = 0; i < 10; i++) {
				states.push(sm.currentState.name);
				sm.transition();
			}

			expect(states).not.toContain("c");
		});
	});

	describe("when transition to a state is 0", () => {
		it("does not change to that state", () => {
			const sm = new StateMarkov({
				a: { b: 1, c: 0 },
				b: { a: 1, c: 0 },

				c: { a: 0.5, b: 0.5 },
			});

			const states: string[] = [];
			for (let i = 0; i < 10; i++) {
				states.push(sm.currentState.name);
				sm.transition();
			}

			expect(states).not.toContain("c");
		});
	});

	describe("circular transition", () => {
		it("does not change to that state", () => {
			const sm = new StateMarkov({
				a: { b: 1 },
				b: { a: 1 },
			});

			const states: string[] = [];
			for (let i = 0; i < 4; i++) {
				states.push(sm.currentState.name);
				sm.transition();
			}

			expect(states).toEqual(["a", "b", "a", "b"]);
		});
	});

	describe("when sum of weights is more than 1", () => {
		it("throws an error", () => {
			expect(
				() => new StateMarkov({ a: { a: 0.5, b: 0.6 }, b: { a: 1 } }),
			).toThrowError("weight sum must be less than or equal to 1, got: 1.1");
		});
	});

	describe("when state is not defined", () => {
		it("throws an error", () => {
			expect(() => new StateMarkov({ a: { b: 1 } })).toThrowError(
				"undefined state 'b'",
			);
		});
	});
});
