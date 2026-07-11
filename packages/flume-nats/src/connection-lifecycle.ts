import { Events } from "nats";
import { BrokerProbe } from "./broker-probe";

export interface StatusEmitter {
	status(): AsyncIterable<{ type: string }>;
}

export class ConnectionLifecycle {
	constructor(private readonly probe: BrokerProbe) {}

	async watch(source: StatusEmitter): Promise<void> {
		try {
			for await (const status of source.status()) {
				if (status.type === Events.Disconnect) this.probe.disconnected();
				else if (status.type === Events.Reconnect) this.probe.reconnected();
			}
		} catch {
			// the status stream throws when the connection closes on shutdown — expected
		}
	}
}
