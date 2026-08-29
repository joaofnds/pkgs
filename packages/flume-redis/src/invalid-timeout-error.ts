export class InvalidTimeoutError extends Error {
	constructor(
		readonly option: string,
		readonly value: number,
	) {
		super(
			`${option} must be an integer of at least 1 millisecond, got ${value}`,
		);
		this.name = "InvalidTimeoutError";
	}
}
