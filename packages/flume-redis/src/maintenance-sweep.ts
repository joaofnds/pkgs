import { SweepAlreadyStartedError } from "./sweep-already-started-error";

export class MaintenanceSweep {
	private inFlight = false;
	private skippedTicks = 0;
	private timer?: ReturnType<typeof setInterval>;

	constructor(
		private readonly sweep: () => Promise<void>,
		private readonly reportFailure: (error: unknown) => void,
		private readonly intervalMs: number,
	) {}

	get skipped(): number {
		return this.skippedTicks;
	}

	start(): void {
		if (this.timer !== undefined) throw new SweepAlreadyStartedError();

		this.timer = setInterval(() => this.run(), this.intervalMs);
	}

	stop(): void {
		if (this.timer === undefined) return;

		clearInterval(this.timer);
		this.timer = undefined;
	}

	async run(): Promise<void> {
		if (this.inFlight) {
			this.skippedTicks += 1;
			return;
		}

		this.inFlight = true;
		try {
			await this.sweep();
		} catch (error) {
			this.reportFailure(error);
		} finally {
			this.inFlight = false;
		}
	}
}
