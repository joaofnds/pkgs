import { DeliveryMode } from "../domain/delivery-mode";
import { EventHandler } from "../domain/event-handler";
import { RetryPolicy } from "../domain/retry-policy";
import { StartFrom, Subscription } from "../domain/subscription";
import { Topic } from "../domain/topic";
import { Clock } from "../ports/clock";
import { Codec } from "../ports/codec";
import { Broker } from "../ports/consumer";
import { Probe } from "../ports/probe";
import { Dispatcher } from "./dispatcher";
import { Worker } from "./worker";

const DEFAULT_MAX_ATTEMPTS = 5;

export interface SubscribeOptions {
	retry?: RetryPolicy;
	delivery?: DeliveryMode;
	startFrom?: StartFrom;
}

// The event-emitter-like surface over Dispatcher + Worker. `emit` is async (it
// crosses the broker) and `on` requires a stable `name` (the durable identity).
// The `namespace` (your service identity) is folded into every subscription name
// so two services subscribing the same handler name to the same topic stay
// isolated. The underlying Dispatcher/Worker stay reachable for advanced wiring.
export class Flume {
	readonly namespace: string;
	private readonly dispatcher: Dispatcher;
	private readonly worker: Worker;

	constructor(props: {
		namespace: string;
		broker: Broker;
		codec: Codec;
		clock: Clock;
		probe: Probe;
	}) {
		this.namespace = props.namespace;
		this.dispatcher = new Dispatcher(
			props.broker,
			props.codec,
			props.clock,
			props.probe,
		);
		this.worker = new Worker(
			props.broker,
			props.broker,
			props.codec,
			props.probe,
		);
	}

	emit(topic: string, payload: unknown): Promise<void> {
		return this.dispatcher.dispatch(new Topic(topic), payload);
	}

	on(
		topic: string,
		name: string,
		handler: EventHandler,
		options: SubscribeOptions = {},
	): void {
		this.worker.register(
			new Subscription({
				topic: new Topic(topic),
				name: `${this.namespace}:${name}`,
				handler,
				retry:
					options.retry ??
					new RetryPolicy({ maxAttempts: DEFAULT_MAX_ATTEMPTS }),
				delivery: options.delivery ?? DeliveryMode.Competing,
				startFrom: options.startFrom,
			}),
		);
	}

	start(): Promise<void> {
		return this.worker.start();
	}

	stop(): Promise<void> {
		return this.worker.stop();
	}
}
