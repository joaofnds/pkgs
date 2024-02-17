export function weightedRandomIndex(weights: number[]): number {
	let sum = 0;
	const rand = Math.random();

	for (let i = 0; i < weights.length; i++) {
		sum += weights[i];
		if (rand <= sum) return i;
	}

	return 0;
}
