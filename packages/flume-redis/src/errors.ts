import { ClientClosedError } from "redis";
import { BrokerClosedError } from "./broker-closed-error";
import { BrokerError } from "./broker-error";
import { ReadDeadlineError } from "./read-deadline-error";

export function isClientClosedError(error: unknown): boolean {
	return error instanceof ClientClosedError;
}

export function isNoGroupError(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith("NOGROUP");
}

export function isReadDeadlineError(error: unknown): boolean {
	return error instanceof ReadDeadlineError;
}

export function asBrokerError(error: unknown): BrokerError {
	if (isClientClosedError(error)) {
		return new BrokerClosedError({ cause: error });
	}
	return new BrokerError("redis command failed", { cause: error });
}
