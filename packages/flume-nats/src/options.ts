import { hostname } from "node:os";
import { ConnectionOptions } from "nats";

export interface NatsBrokerOptions {
	readonly nats: ConnectionOptions;
	// identity of a broadcast group per instance (default {host}:{pid}).
	readonly instanceId?: string;
	// max in-flight messages a consumer pulls at a time.
	readonly readCount?: number;
	// how long the server waits for an ack before redelivering, in milliseconds.
	readonly ackWait?: number;
}

export interface ResolvedNatsOptions {
	readonly nats: ConnectionOptions;
	readonly instanceId: string;
	readonly readCount: number;
	readonly ackWait: number;
}

export function resolveOptions(
	options: NatsBrokerOptions,
): ResolvedNatsOptions {
	return {
		nats: options.nats,
		instanceId: options.instanceId ?? `${hostname()}:${process.pid}`,
		readCount: options.readCount ?? 10,
		ackWait: options.ackWait ?? 5000,
	};
}
