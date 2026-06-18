import { Topic } from "../domain/topic";
import { Bytes } from "./codec";

export interface Publisher {
	publish(topic: Topic, body: Bytes): Promise<void>;
}
