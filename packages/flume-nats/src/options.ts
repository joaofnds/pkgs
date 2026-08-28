import { hostname } from "node:os";
import { NodeConnectionOptions } from "@nats-io/transport-node";
import { InvalidConcurrencyError } from "./invalid-concurrency-error";

export interface NatsBrokerOptions {
	readonly nats: NodeConnectionOptions;
	// identity of a broadcast group per instance (default {host}:{pid}).
	readonly instanceId?: string;
	// max handler invocations in flight per consumer; 1 = serial.
	readonly concurrency?: number;
	// how long the server waits for an ack before redelivering, in milliseconds.
	// at concurrency 1 a second buffered message's ackWait clock runs while the
	// first is handled, so a handler duration approaching ackWait risks its
	// redelivery.
	readonly ackWait?: number;
}

export interface ResolvedNatsOptions {
	readonly nats: NodeConnectionOptions;
	readonly instanceId: string;
	readonly concurrency: number;
	readonly ackWait: number;
}

export function resolveOptions(
	options: NatsBrokerOptions,
): ResolvedNatsOptions {
	const concurrency = options.concurrency ?? 10;
	if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
		throw new InvalidConcurrencyError(concurrency);
	}

	return {
		nats: options.nats,
		instanceId: options.instanceId ?? `${hostname()}:${process.pid}`,
		concurrency,
		ackWait: options.ackWait ?? 5000,
	};
}
