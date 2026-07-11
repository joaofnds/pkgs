export interface BrokerProbe {
	connected(): void;
	disconnected(): void;
	reconnected(): void;
	deliveryFailed(error: unknown): void;
}
