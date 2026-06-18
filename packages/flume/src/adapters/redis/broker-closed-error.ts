import { BrokerError } from "./broker-error";

// The client (or the whole broker) was closed while a command was in flight —
// the expected outcome of shutting the broker down. Distinct so callers can tell
// an orderly close from a genuine failure.
export class BrokerClosedError extends BrokerError {
	constructor(options?: { cause?: unknown }) {
		super("redis client is closed", options);
		this.name = "BrokerClosedError";
	}
}
