import { OnEvent } from "@nestjs/event-emitter";
import Bull from "bull";

export type OnBackgroundEventOptions = {
	aliases?: string[];
	job?: Bull.JobOptions;
};

export type ListenerConfig = {
	name: string;
	backgroundEvent: string;
	options?: OnBackgroundEventOptions;
};

export const registeredEvents = new Map<string, ListenerConfig[]>();
export const eventPrefix = "background";
export const eventSeparator = ":";

export function OnBackgroundEvent(
	event: string,
	options?: OnBackgroundEventOptions,
): MethodDecorator {
	return (
		target: object,
		propertyKey: string | symbol,
		descriptor: PropertyDescriptor,
	) => {
		const name = `${target.constructor.name}.${String(propertyKey)}`;
		const backgroundEvent = backgroundEventName(event, name);

		registerEvent(event, { name, backgroundEvent, options });

		return OnEvent(backgroundEventName(event, name), {
			async: false,
			promisify: true,
			suppressErrors: false,
		})(target, propertyKey, descriptor);
	};
}

function backgroundEventName(event: string, listenerName: string): string {
	return [eventPrefix, event, listenerName].join(eventSeparator);
}

function registerEvent(event: string, listener: ListenerConfig) {
	const listeners = registeredEvents.get(event);
	if (listeners) {
		listeners.push(listener);
	} else {
		registeredEvents.set(event, [listener]);
	}
}
