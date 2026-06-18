import { Clock } from "../ports";

// Core default clock. Reads real wall-clock time in production wiring.
export class SystemClock implements Clock {
	now(): Date {
		return new Date();
	}
}
