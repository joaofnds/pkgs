// Time as an injected dependency — no global Date access in the core, so the
// Dispatcher's `dispatchedAt` stamping is deterministic under test.
export interface Clock {
	now(): Date;
}
