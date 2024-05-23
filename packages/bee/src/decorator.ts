import { BeeListener } from "./listener";
import { EventRegistry } from "./registry";
import { OnBackgroundEventOptions } from "./types";

export const registry = new EventRegistry();

export function OnBackgroundEvent(
	event: string,
	options?: OnBackgroundEventOptions,
): MethodDecorator {
	const listener = new BeeListener(event, options);
	registry.register(listener);
	return listener.decorate.bind(listener);
}
