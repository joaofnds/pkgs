import { DeliveredMessage } from "@joaofnds/flume";

export class Collector {
	readonly messages: DeliveredMessage[] = [];
	mode: "ack" | "nack" = "ack";

	deliver = async (msg: DeliveredMessage): Promise<void> => {
		this.messages.push(msg);
		if (this.mode === "ack") await msg.ack();
		else await msg.nack();
	};

	bodies(): string[] {
		return this.messages.map((msg) => new TextDecoder().decode(msg.body));
	}
}
