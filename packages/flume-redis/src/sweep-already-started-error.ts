export class SweepAlreadyStartedError extends Error {
	constructor() {
		super("maintenance sweep already started");
		this.name = "SweepAlreadyStartedError";
	}
}
