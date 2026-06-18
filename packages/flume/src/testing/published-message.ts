import { Topic } from "../domain/topic";
import { Bytes } from "../ports/codec";

export class PublishedMessage {
	constructor(
		readonly topic: Topic,
		readonly body: Bytes,
	) {}
}
