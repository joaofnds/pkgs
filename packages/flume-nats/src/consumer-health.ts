import { Clock, SystemClock } from "@joaofnds/flume";
import { ConsumerNotification } from "@nats-io/jetstream";
import { BrokerProbe, DegradationReason, StallReason } from "./broker-probe";

// A status notification is paced by the server, not by flume, so emission is
// bounded rather than passed straight through. One second is fifteen times
// faster than the fastest real signal (idle_heartbeat defaults to 15s), so the
// bound never delays a genuine report.
export const REPORT_INTERVAL_MS = 1000;

type ReportedVerdict =
	| { readonly kind: "stalled"; readonly reason: StallReason }
	| { readonly kind: "degraded"; readonly reason: DegradationReason };

type HealthVerdict = ReportedVerdict | { readonly kind: "ignored" };

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

interface ReasonState {
	readonly verdict: ReportedVerdict;
	lastEmittedAt: number;
	suppressed: number;
	consecutive?: number;
}

// Only these two notifications carry the library's own consecutive-failure
// count; the reachable stream_not_found emits { type, name } alone.
function consecutiveOf(notification: ConsumerNotification): number | undefined {
	return notification.type === "heartbeats_missed" ||
		notification.type === "consumer_not_found"
		? notification.count
		: undefined;
}

export class ConsumerHealth {
	constructor(
		private readonly probe: BrokerProbe,
		private readonly clock: Clock = new SystemClock(),
	) {}

	async watch(
		source: AsyncIterable<ConsumerNotification>,
		subject: string,
		durable: string,
	): Promise<void> {
		const states = new Map<string, ReasonState>();

		// the body never awaits: the status listener is an unbounded queue, and
		// only a synchronous body keeps it shallow
		for await (const notification of source) {
			const verdict = VERDICTS[notification.type];
			if (verdict.kind === "ignored") continue;

			const state = this.stateFor(states, verdict);
			state.suppressed += 1;
			state.consecutive = consecutiveOf(notification);
			if (this.due(state)) this.emit(state, subject, durable);
		}

		for (const state of states.values()) {
			if (state.suppressed > 0) this.emit(state, subject, durable);
		}
	}

	private stateFor(
		states: Map<string, ReasonState>,
		verdict: ReportedVerdict,
	): ReasonState {
		const existing = states.get(verdict.reason);
		if (existing) return existing;

		const state: ReasonState = {
			verdict,
			lastEmittedAt: Number.NEGATIVE_INFINITY,
			suppressed: 0,
		};
		states.set(verdict.reason, state);
		return state;
	}

	private due(state: ReasonState): boolean {
		return (
			this.clock.now().getTime() - state.lastEmittedAt >= REPORT_INTERVAL_MS
		);
	}

	private emit(state: ReasonState, subject: string, durable: string): void {
		const occurrences = state.suppressed;
		state.suppressed = 0;
		state.lastEmittedAt = this.clock.now().getTime();

		if (state.verdict.kind === "stalled") {
			this.probe.consumerStalled({
				subject,
				durable,
				reason: state.verdict.reason,
				occurrences,
				consecutive: state.consecutive,
			});
		} else {
			this.probe.consumerDegraded({
				subject,
				durable,
				reason: state.verdict.reason,
				occurrences,
			});
		}
	}
}
