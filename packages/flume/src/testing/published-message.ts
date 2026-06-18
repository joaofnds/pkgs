import { Topic } from "../domain/topic";
import { Bytes } from "../ports/codec";

// A message recorded by `publish` — a dispatched envelope or a dead-letter copy.
export class PublishedMessage {
	constructor(
		readonly topic: Topic,
		readonly body: Bytes,
	) {}
}
