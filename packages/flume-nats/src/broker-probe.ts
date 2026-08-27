export type StallReason =
	| "consumer_deleted"
	| "consumer_not_found"
	| "stream_not_found"
	| "heartbeats_missed";

export type DegradationReason =
	| "no_responders"
	| "exceeded_limits"
	| "status_watch_failed";

export interface ConsumerStop {
	readonly subject: string;
	readonly durable: string;
	readonly error: unknown;
}

export interface ConsumerStall {
	readonly subject: string;
	readonly durable: string;
	readonly reason: StallReason;
	readonly occurrences: number;
	readonly consecutive?: number;
}

export interface ConsumerDegradation {
	readonly subject: string;
	readonly durable: string;
	readonly reason: DegradationReason;
	readonly occurrences: number;
}

export interface BrokerProbe {
	connected(): void;
	disconnected(): void;
	reconnected(): void;
	deliveryFailed(error: unknown): void;
	consumerStopped(stop: ConsumerStop): void;
	consumerStalled(stall: ConsumerStall): void;
	consumerDegraded(degradation: ConsumerDegradation): void;
}
