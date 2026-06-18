import { randomUUID } from "node:crypto";

// Poll a predicate until it holds or the timeout elapses. The integration-test
// alternative to a fixed sleep: it returns as soon as the condition is true, and
// fails loudly (not silently) if it never becomes true.
export async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	options: { timeout?: number; interval?: number; message?: string } = {},
): Promise<void> {
	const timeout = options.timeout ?? 5000;
	const interval = options.interval ?? 10;
	const deadline = Date.now() + timeout;

	while (Date.now() < deadline) {
		if (await predicate()) return;
		await delay(interval);
	}
	if (await predicate()) return;

	throw new Error(options.message ?? `condition not met within ${timeout}ms`);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// A per-worker prefix so topic names stay collision-free across test files, which
// vitest runs in separate worker processes (a plain counter would restart at 1 in
// each worker and collide on the shared Redis).
const RUN_ID = randomUUID().slice(0, 8);
let counter = 0;

// A fresh, globally-unique topic name per call so tests stay independent on the
// shared Redis without nuking it between tests.
export function uniqueTopic(prefix = "topic"): string {
	counter += 1;
	return `${prefix}.${RUN_ID}.${counter}`;
}
