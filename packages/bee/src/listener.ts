import * as assert from "node:assert";
import { OnEvent } from "@nestjs/event-emitter";
import { OnBackgroundEventOptions } from "./types";

export class BeeListener {
	static readonly eventPrefix = "background";
	static readonly eventSeparator = ":";

	readonly event: string;
	readonly options?: OnBackgroundEventOptions;

	target = "";
	targetedEvent = "";

	constructor(event: string, options: OnBackgroundEventOptions = {}) {
		this.event = event;
		this.options = options;
	}

	decorate(
		target: object,
		propertyKey: string | symbol,
		descriptor: PropertyDescriptor,
	) {
		this.target = `${target.constructor.name}.${propertyKey.toString()}`;
		this.targetedEvent = [
			BeeListener.eventPrefix,
			this.event,
			this.target,
		].join(BeeListener.eventSeparator);
		const paramTypes =
			Reflect.getMetadata("design:paramtypes", target, propertyKey) || [];

		const originalMethod = descriptor.value;
		descriptor.value = async function (...params: unknown[]) {
			assert.ok(paramTypes.length <= params.length);

			const parsedParams = params.map((event, i) => {
				const EventClass = paramTypes[i];

				if (typeof EventClass?.fromPlain === "function") {
					return EventClass.fromPlain(event);
				}

				return event;
			});

			return originalMethod.apply(this, parsedParams);
		};

		return OnEvent(this.targetedEvent, {
			async: false,
			promisify: true,
			suppressErrors: false,
		})(target, propertyKey, descriptor);
	}
}
