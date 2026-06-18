import { Topic } from "../domain";
import { Bytes } from "./codec";

// Producer side. The API tier needs only this. `body` is the framed envelope
// bytes (versioned wire format); the adapter treats it as opaque.
export interface Publisher {
	publish(topic: Topic, body: Bytes): Promise<void>;
}
