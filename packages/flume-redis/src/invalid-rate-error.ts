export class InvalidRateError extends Error {
	constructor(
		readonly option: string,
		readonly value: number,
	) {
		super(`${option} must be a finite number of at least 0, got ${value}`);
		this.name = "InvalidRateError";
	}
}
