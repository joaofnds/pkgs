import { DeliveredMessage } from "../ports/consumer";
import { Probe } from "../ports/probe";
import { FakeDeliveredMessage } from "../testing/fake-delivered-message";

export interface ProbeCall {
	call: "dispatched" | "processed" | "failed" | "deadLettered";
	acked: boolean;
	nacked: boolean;
}

export class OrderProbe implements Probe {
	readonly calls: ProbeCall[] = [];

	dispatched(): void {
		this.calls.push({ call: "dispatched", acked: false, nacked: false });
	}

	processed(_sub: unknown, msg: DeliveredMessage): void {
		this.record("processed", msg);
	}

	failed(_sub: unknown, msg: DeliveredMessage): void {
		this.record("failed", msg);
	}

	deadLettered(_sub: unknown, msg: DeliveredMessage): void {
		this.record("deadLettered", msg);
	}

	private record(call: ProbeCall["call"], msg: DeliveredMessage): void {
		const acked = msg instanceof FakeDeliveredMessage ? msg.acked : false;
		const nacked = msg instanceof FakeDeliveredMessage ? msg.nacked : false;
		this.calls.push({ call, acked, nacked });
	}
}
