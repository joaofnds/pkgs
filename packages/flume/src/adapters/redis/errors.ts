import { ClientClosedError } from "redis";
import { BrokerClosedError } from "./broker-closed-error";
import { BrokerError } from "./broker-error";

export function isClientClosedError(error: unknown): boolean {
	return error instanceof ClientClosedError;
}

// Translate a driver error raised by a single command into a broker error.
export function asBrokerError(error: unknown): BrokerError {
	if (isClientClosedError(error)) {
		return new BrokerClosedError({ cause: error });
	}
	return new BrokerError("redis command failed", { cause: error });
}
