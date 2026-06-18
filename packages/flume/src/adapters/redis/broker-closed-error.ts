import { BrokerError } from "./broker-error";

export class BrokerClosedError extends BrokerError {
	constructor(options?: { cause?: unknown }) {
		super("redis client is closed", options);
		this.name = "BrokerClosedError";
	}
}
