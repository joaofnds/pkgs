import { BrokerError } from "./broker-error";

export class ReadDeadlineError extends BrokerError {
	constructor(
		operation: string,
		deadline: number,
		options?: { cause?: unknown },
	) {
		super(
			`redis read client exceeded its ${deadline}ms deadline on ${operation}`,
			options,
		);
		this.name = "ReadDeadlineError";
	}
}
