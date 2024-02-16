export interface Ticker {
	start(fn: () => void, interval: number): void;
	stop(): void;
}
