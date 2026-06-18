import { Probe } from "../ports/probe";

// Every probe call throws — proves the core's guard keeps messaging working when
// observability misbehaves.
export class ThrowingProbe implements Probe {
	dispatched(): void {
		throw new Error("probe boom");
	}
	processed(): void {
		throw new Error("probe boom");
	}
	failed(): void {
		throw new Error("probe boom");
	}
	deadLettered(): void {
		throw new Error("probe boom");
	}
}
