import { Topic } from "../domain";
import { Clock, Codec, Probe, Publisher } from "../ports";
import { Envelope } from "./envelope";
import { GuardedProbe } from "./guarded-probe";

// Producer side. Frames the versioned envelope — stamping dispatchedAt from the
// injected Clock, no global time — and publishes its bytes. The durable publish
// happens first; the probe call is last and guarded, so a thrown probe can never
// make a successful dispatch reject.
export class Dispatcher {
	private readonly probe: Probe;

	constructor(
		private readonly publisher: Publisher,
		private readonly codec: Codec,
		private readonly clock: Clock,
		probe: Probe,
	) {
		this.probe = new GuardedProbe(probe);
	}

	async dispatch(topic: Topic, payload: unknown): Promise<void> {
		const envelope = new Envelope({
			dispatchedAt: this.clock.now(),
			payload: this.codec.encode(payload),
		});
		await this.publisher.publish(topic, envelope.toBytes());
		this.probe.dispatched(topic);
	}
}
