import { Ticker } from "../src";

export class FakeTicker implements Ticker {
	private state: "stopped" | "running" = "stopped";
	private fn: () => void;

	start(fn: () => void, _interval: number): void {
		this.fn = fn;
		this.state = "running";
	}

	stop(): void {
		this.state = "stopped";
	}

	tick() {
		this.fn();
	}

	isRunning() {
		return this.state === "running";
	}

	isStopped() {
		return this.state === "stopped";
	}
}
