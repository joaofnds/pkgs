import { Bytes } from "@joaofnds/flume";
import { BrokerError } from "./broker-error";

export const PAYLOAD_FIELD = "payload";

export function idOf(id: Buffer | string): string {
	return id.toString();
}

export function bodyOf(message: Record<string, Buffer>): Bytes {
	const body = message[PAYLOAD_FIELD];
	if (body === undefined) {
		throw new BrokerError(
			`stream message is missing the "${PAYLOAD_FIELD}" field`,
		);
	}
	return body;
}
