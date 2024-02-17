class DifferentLengthError extends Error {
	constructor(states: unknown[], weights: unknown[]) {
		super();
		this.message = `'${states}' and '${weights}' must have the same length, got ${states.length} for length and ${weights.length} for weights`;
	}
}

export class UndefinedStateError extends Error {
	constructor(stateName: string) {
		super();
		this.message = `undefined state '${stateName}'. Make sure to declare it as a top-level key`;
	}
}

export function assertSameLength(a: unknown[], b: unknown[]) {
	if (a.length !== b.length) {
		throw new DifferentLengthError(a, b);
	}
}

export function assertSumTo1(numbers: number[]) {
	const sum = numbers.reduce((sum, w) => sum + w, 0);
	if (sum > 1) {
		throw new Error(`weight sum must be less than or equal to 1, got: ${sum}`);
	}
}
