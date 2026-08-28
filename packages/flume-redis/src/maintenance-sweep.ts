export class MaintenanceSweep {
	private inFlight = false;
	private skippedTicks = 0;

	constructor(
		private readonly sweep: () => Promise<void>,
		private readonly reportFailure: (error: unknown) => void,
	) {}

	get skipped(): number {
		return this.skippedTicks;
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
