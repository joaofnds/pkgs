import { EventEmitter2 } from "@nestjs/event-emitter";
import { RedisClientOptions } from "redis";

export interface Message {
	id: string;
	message: Record<string, string>;
}

export interface SendableEvent {
	name: string;
	serialize(eventData: unknown): string;
}

export interface ReceivableEvent {
	name: string;
	deserialize(serializedEvent: string): unknown;
}

export interface StreamOptions {
	group: string;
	consumer: string;
	readTimeout: number;
	maxLen: number;
	deadMaxLen: number;
}

export interface ReclaimOptions {
	throughputThreshold: number;
	interval: number;
	minIdleTime: number;
	count: number;
	maxDeliveries: number;
}

export interface Options {
	redis: RedisClientOptions;
	stream: StreamOptions;
	reclaim: ReclaimOptions;
	receiveEvents: ReceivableEvent[];
	sendEvents: SendableEvent[];
	eventEmitter: EventEmitter2;
}
