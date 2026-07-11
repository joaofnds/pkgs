import { Topic } from "../domain/topic";
import { Clock } from "../ports/clock";
import { Codec } from "../ports/codec";
import { Probe } from "../ports/probe";
import { Publisher } from "../ports/publisher";
import { Envelope } from "./envelope";
import { GuardedProbe } from "./guarded-probe";

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
		try {
			await this.publisher.publish(topic, envelope.toBytes());
		} catch (error) {
			this.probe.dispatchFailed(topic, error);
			throw error;
		}
		this.probe.dispatched(topic);
	}
}
