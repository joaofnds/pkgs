// Outcome of a dead-letter redrive pass.
export interface RedriveResult {
	// Original messages re-published to the live topic this pass.
	readonly redriven: number;
	// Entries skipped because their originalId was already redriven before.
	readonly skipped: number;
}
