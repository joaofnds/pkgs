import { Ticker } from "./ticker";

export class SetIntervalTicker implements Ticker {
	private intervalID?: NodeJS.Timeout;

	start(fn: () => void, interval: number): void {
		this.intervalID = setInterval(fn, interval);
	}

	stop(): void {
		clearInterval(this.intervalID);
	}
}
