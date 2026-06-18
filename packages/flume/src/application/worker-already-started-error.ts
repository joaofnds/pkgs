export class WorkerAlreadyStartedError extends Error {
	constructor() {
		super("worker already started; register all subscriptions before start()");
		this.name = "WorkerAlreadyStartedError";
	}
}
