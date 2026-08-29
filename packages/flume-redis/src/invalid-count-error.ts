export class InvalidCountError extends Error {
	constructor(
		readonly option: string,
		readonly value: number,
	) {
		super(`${option} must be an integer of at least 1, got ${value}`);
		this.name = "InvalidCountError";
	}
}
