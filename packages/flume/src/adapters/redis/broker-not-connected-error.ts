import { BrokerError } from "./broker-error";

export class BrokerNotConnectedError extends BrokerError {
	constructor() {
		super("broker is not connected; call connect() before use");
		this.name = "BrokerNotConnectedError";
	}
}
