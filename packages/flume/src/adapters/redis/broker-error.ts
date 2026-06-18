// Error-translation boundary (coding_style §2e): the adapter catches node-redis
// driver errors and re-throws them as Flume broker errors, so infrastructure
// error types never leak into the core (Worker/Dispatcher only see the port).
export class BrokerError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "BrokerError";
	}
}
