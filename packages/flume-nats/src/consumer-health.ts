import { ConsumerNotification } from "@nats-io/jetstream";
import { BrokerProbe, DegradationReason, StallReason } from "./broker-probe";

type HealthVerdict =
	| { readonly kind: "stalled"; readonly reason: StallReason }
	| { readonly kind: "degraded"; readonly reason: DegradationReason }
	| { readonly kind: "ignored" };

const IGNORED: HealthVerdict = { kind: "ignored" };

const VERDICTS: Record<ConsumerNotification["type"], HealthVerdict> = {
	consumer_deleted: { kind: "stalled", reason: "consumer_deleted" },
	consumer_not_found: { kind: "stalled", reason: "consumer_not_found" },
	stream_not_found: { kind: "stalled", reason: "stream_not_found" },
	heartbeats_missed: { kind: "stalled", reason: "heartbeats_missed" },
	no_responders: { kind: "degraded", reason: "no_responders" },
	exceeded_limits: { kind: "degraded", reason: "exceeded_limits" },
	debug: IGNORED,
	discard: IGNORED,
	next: IGNORED,
	heartbeat: IGNORED,
	flow_control: IGNORED,
	consumer_pinned: IGNORED,
	consumer_unpinned: IGNORED,
	reset: IGNORED,
	ordered_consumer_recreated: IGNORED,
};

export class ConsumerHealth {
	constructor(private readonly probe: BrokerProbe) {}

	async watch(
		source: AsyncIterable<ConsumerNotification>,
		subject: string,
		durable: string,
	): Promise<void> {
		for await (const notification of source) {
			const verdict = VERDICTS[notification.type];

			if (verdict.kind === "stalled") {
				this.probe.consumerStalled({
					subject,
					durable,
					reason: verdict.reason,
					occurrences: 1,
				});
			} else if (verdict.kind === "degraded") {
				this.probe.consumerDegraded({
					subject,
					durable,
					reason: verdict.reason,
					occurrences: 1,
				});
			}
		}
	}
}
