import { Event } from "./event";

// The durable-unit role. Concrete handlers are classes with injected deps.
export interface EventHandler<T = unknown> {
	handle(event: Event<T>): Promise<void>;
}
