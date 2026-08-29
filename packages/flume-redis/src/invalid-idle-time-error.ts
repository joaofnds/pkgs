export class InvalidIdleTimeError extends Error {
	constructor(
		readonly option: string,
		readonly value: number,
	) {
		super(
			`${option} must be an integer of at least 0 milliseconds, got ${value}`,
		);
		this.name = "InvalidIdleTimeError";
	}
}
