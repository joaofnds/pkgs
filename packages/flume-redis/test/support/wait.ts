import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

export async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	options: { timeout?: number; interval?: number; message?: string } = {},
): Promise<void> {
	const timeout = options.timeout ?? 5000;
	const interval = options.interval ?? 10;
	const deadline = Date.now() + timeout;

	while (Date.now() < deadline) {
		if (await predicate()) return;
		await sleep(interval);
	}
	if (await predicate()) return;

	throw new Error(options.message ?? `condition not met within ${timeout}ms`);
}

const RUN_ID = randomUUID().slice(0, 8);
let counter = 0;

export function uniqueTopic(prefix = "topic"): string {
	counter += 1;
	return `${prefix}.${RUN_ID}.${counter}`;
}
