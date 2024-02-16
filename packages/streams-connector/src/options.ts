import { EventEmitter2 } from "@nestjs/event-emitter";
import { RedisClientOptions } from "redis";
import {
	Options,
	ReceivableEvent,
	ReclaimOptions,
	SendableEvent,
	StreamOptions,
} from "./types";

export class StreamsConnectorOptions {
	readonly redis: RedisClientOptions;
	readonly stream: StreamOptions;
	readonly reclaim: ReclaimOptions;
	private readonly receiveEvents: ReceivableEvent[];
	readonly sendEvents: SendableEvent[];
	readonly eventEmitter: EventEmitter2;

	constructor({
		redis,
		stream,
		reclaim,
		receiveEvents,
		sendEvents,
		eventEmitter,
	}: Options) {
		this.redis = redis;
		this.stream = stream;
		this.reclaim = reclaim;
		this.receiveEvents = receiveEvents;
		this.sendEvents = sendEvents;
		this.eventEmitter = eventEmitter;
	}

	get streams() {
		return this.receiveEvents.map((e) => e.name);
	}

	eventFor(stream: string) {
		return this.receiveEvents.find((e) => e.name === stream);
	}
}
