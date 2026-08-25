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
		return this.#events.keys().toArray();
	}

	eventListeners(event: string) {
		return this.#events.get(event) ?? [];
	}

	listeners() {
		return this.#events.values().toArray().flat();
	}
}
