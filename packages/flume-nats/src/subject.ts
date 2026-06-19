import { DeliveryMode, Subscription } from "@joaofnds/flume";

// One JetStream stream captures every Flume subject. Topics are arbitrary
// strings, so each is published under a "flume." prefix and the stream binds the
// "flume.>" wildcard. The stream name itself has no dots.
export const STREAM = "flume";
const SUBJECT_PREFIX = "flume.";
export const STREAM_SUBJECTS = [`${SUBJECT_PREFIX}>`];

export function subjectFor(topic: string): string {
	return `${SUBJECT_PREFIX}${topic}`;
}

// A durable consumer is keyed by (topic, sub.name) — the same identity Redis
// gets from a per-stream group. Broadcast adds the instanceId so every instance
// owns a distinct durable and sees every event; competing consumers share one
// durable and JetStream load-balances across the bound clients. NATS durable
// names forbid ".", "*", ">" and whitespace, so non-word characters are folded
// to "_".
export function durableFor(sub: Subscription, instanceId: string): string {
	const base =
		sub.delivery === DeliveryMode.Broadcast
			? `${sub.topic.name}__${sub.name}__${instanceId}`
			: `${sub.topic.name}__${sub.name}`;
	return base.replace(/[^a-zA-Z0-9_-]/g, "_");
}
