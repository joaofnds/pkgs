import { ClientClosedError } from "redis";

// Error-translation boundary (coding_style §2e): the adapter catches node-redis
// driver errors and re-throws them as Flume broker errors, so infrastructure
// error types never leak into the core (Worker/Dispatcher only see the port).
export class BrokerError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "BrokerError";
	}
}

// The client (or the whole broker) was closed while a command was in flight —
// the expected outcome of shutting the broker down. Distinct so callers can tell
// an orderly close from a genuine failure.
export class BrokerClosedError extends BrokerError {
	constructor(options?: { cause?: unknown }) {
		super("redis client is closed", options);
		this.name = "BrokerClosedError";
	}
}

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
