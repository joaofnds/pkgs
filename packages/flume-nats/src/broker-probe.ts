export interface BrokerProbe {
	connected(): void;
	disconnected(): void;
	reconnected(): void;
	deliveryFailed(error: unknown): void;
	consumerStopped(subject: string, durable: string, error: unknown): void;
}
