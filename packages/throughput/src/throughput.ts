import { SetIntervalTicker } from "./set-interval-ticker";
import { Ticker } from "./ticker";

export class Throughput {
	private hits = 0;
	private readonly probes: number[];
	private readonly windowDuration: number;

	constructor(
		private readonly probeSize = 60,
		private readonly probeInterval = 1000,
		private readonly ticker: Ticker = new SetIntervalTicker(),
		private readonly now = Date.now,
	) {
		this.probes = new Array(this.probeSize).fill(0);
		this.windowDuration = this.probeSize * this.probeInterval;
	}

	start() {
		this.ticker.start(() => {
			const i = Math.floor(this.now() / this.probeInterval) % this.probeSize;
			this.probes[i] = this.hits;
			this.hits = 0;
		}, this.probeInterval);
	}

	stop() {
		this.ticker.stop();
	}

	[Symbol.dispose]() {
		this.stop();
	}

	hit() {
		this.hits++;
	}

	perWindow() {
		return this.total() / this.probeSize;
	}

	perMillisecond() {
		return this.total() / this.windowDuration;
	}

	perSecond() {
		return this.total() / (this.windowDuration / 1000);
	}

	perMinute() {
		return this.total() / (this.windowDuration / 1000 / 60);
	}

	perHour() {
		return this.total() / (this.windowDuration / 1000 / 60 / 60);
	}

	private total() {
		let total = 0;
		for (const count of this.probes) total += count;
		return total;
	}
}
