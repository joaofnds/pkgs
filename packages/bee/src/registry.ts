import { BeeListener } from "./listener";

export class EventRegistry {
	readonly #events = new Map<string, BeeListener[]>();

	register(listener: BeeListener) {
		const listeners = this.#events.get(listener.event);

		if (listeners) {
			listeners.push(listener);
		} else {
			this.#events.set(listener.event, [listener]);
		}
	}

	events() {
		return Array.from(this.#events.keys());
	}

	eventListeners(event: string) {
		return this.#events.get(event) ?? [];
	}

	listeners() {
		return Array.from(this.#events.values()).flat();
	}
}
