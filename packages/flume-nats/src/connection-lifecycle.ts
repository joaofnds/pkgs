import { BrokerProbe } from "./broker-probe";

export interface StatusEmitter {
	status(): AsyncIterable<{ type: string }>;
}

export class ConnectionLifecycle {
	constructor(private readonly probe: BrokerProbe) {}

	async watch(source: StatusEmitter): Promise<void> {
		try {
			for await (const status of source.status()) {
				if (status.type === "disconnect") this.probe.disconnected();
				else if (status.type === "reconnect") this.probe.reconnected();
			}
		} catch {
			// the status stream ends cleanly on close; only a mid-flight connection error throws
		}
	}
}
