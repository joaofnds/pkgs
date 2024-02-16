import { Ticker } from "../src";

export class FakeTicker implements Ticker {
	private fn: () => void;

	start(fn: () => void, _interval: number): void {
		this.fn = fn;
	}

	stop(): void {}

	tick() {
		this.fn();
	}
}
