import { Event } from "./event";

export interface EventHandler<T = unknown> {
	handle(event: Event<T>): Promise<void>;
}
