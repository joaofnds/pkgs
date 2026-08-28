import { ConsumeMessages } from "@nats-io/jetstream";

export const EXPIRES_MS = 30_000;
export const IDLE_HEARTBEAT_MS = 15_000;

export function consumeOptionsFor(concurrency: number): ConsumeMessages {
	const max_messages = Math.max(concurrency, 2);
	const threshold_messages = Math.min(
		Math.round(0.75 * max_messages),
		max_messages - 1,
	);

	if (
		max_messages < 2 ||
		threshold_messages < 1 ||
		threshold_messages >= max_messages
	) {
		throw new Error(
			`consume options invariant violated: max_messages=${max_messages}, threshold_messages=${threshold_messages}`,
		);
	}

	return {
		max_messages,
		threshold_messages,
		expires: EXPIRES_MS,
		idle_heartbeat: IDLE_HEARTBEAT_MS,
	};
}
