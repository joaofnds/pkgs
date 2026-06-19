export class BrokerNotConnectedError extends Error {
	constructor() {
		super("NATS broker is not connected; call connect() first");
		this.name = "BrokerNotConnectedError";
	}
}
