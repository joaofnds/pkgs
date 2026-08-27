export interface ConsumerStop {
	readonly subject: string;
	readonly durable: string;
	readonly error: unknown;
}

export interface BrokerProbe {
	connected(): void;
	disconnected(): void;
	reconnected(): void;
	deliveryFailed(error: unknown): void;
	consumerStopped(stop: ConsumerStop): void;
}
