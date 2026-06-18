import { Clock } from "../ports/clock";

// Deterministic clock for tests. Starts at the epoch so a test that never sets a
// time still gets a stable, repeatable value.
export class FakeClock implements Clock {
	private current: Date;

	constructor(start: Date = new Date(0)) {
		this.current = start;
	}

	now(): Date {
		return this.current;
	}

	set(date: Date): void {
		this.current = date;
	}

	advance(ms: number): void {
		this.current = new Date(this.current.getTime() + ms);
	}
}
