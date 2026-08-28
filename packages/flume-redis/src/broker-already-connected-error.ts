import { BrokerError } from "./broker-error";

export class BrokerAlreadyConnectedError extends BrokerError {
	constructor() {
		super("broker is already connected; call close() before connecting again");
		this.name = "BrokerAlreadyConnectedError";
	}
}
