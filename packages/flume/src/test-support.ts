import {
	Bytes,
	Codec,
	DeliveredMessage,
	Event,
	EventHandler,
	Probe,
} from "./index";
import { FakeDeliveredMessage } from "./testing/index";

// Test-only fixtures shared across the unit suite. Not part of any shipped entry
// point — these support the core's own tests, mirroring bee's TestListener.

// Records the events it receives and can be toggled to fail, like bee's listener.
export class RecordingHandler implements EventHandler {
	readonly events: Event[] = [];
	shouldFail = false;

	async handle(event: Event): Promise<void> {
		this.events.push(event);
		if (this.shouldFail) {
			throw new Error("intended test failure");
		}
	}

	payloads(): unknown[] {
		return this.events.map((event) => event.payload);
	}
}

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

export interface ProbeCall {
	call: "dispatched" | "processed" | "failed" | "deadLettered";
	acked: boolean;
	nacked: boolean;
}

// Records the message's ack/nack state at the moment each probe call fires, so a
// test can prove the broker side-effect ran BEFORE the probe (PRD §11: probe
// calls are last in each branch, so a misbehaving probe can never block an
// ack/nack). A recording Spy, not a mock framework.
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

// Passthrough binary codec: payload is raw Bytes in and out, so a test can prove
// the wire is binary-clean for non-UTF-8 content end to end.
export class RawBytesCodec implements Codec {
	encode(value: unknown): Bytes {
		if (!(value instanceof Uint8Array)) {
			throw new Error("RawBytesCodec only encodes Uint8Array");
		}
		return value;
	}

	decode(body: Bytes): unknown {
		return body;
	}
}
