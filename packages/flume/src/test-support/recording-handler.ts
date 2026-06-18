import { Event } from "../domain/event";
import { EventHandler } from "../domain/event-handler";

// Records the events it receives and can be toggled to fail, like bee's listener.
export class RecordingHandler implements EventHandler {
	readonly events: Event[] = [];
	shouldFail = false;

	async handle(event: Event): Promise<void> {
		this.events.push(event);
		if (this.shouldFail) {
			throw new Error("intended test failure");
		}
	}

	payloads(): unknown[] {
		return this.events.map((event) => event.payload);
	}
}
