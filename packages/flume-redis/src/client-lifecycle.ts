import { BrokerProbe } from "./broker-probe";

export interface LifecycleEmitter {
	on(event: "ready" | "reconnecting", listener: () => void): unknown;
}

export class ClientLifecycle {
	private connected = false;

	constructor(private readonly probe: BrokerProbe) {}

	watch(client: LifecycleEmitter): void {
		client.on("ready", () => {
			if (this.connected) {
				this.probe.reconnected();
				return;
			}
			this.connected = true;
			this.probe.connected();
		});
		client.on("reconnecting", () => {
			this.probe.disconnected();
		});
	}
}
