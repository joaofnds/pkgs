import { BrokerProbe } from "./broker-probe";

export interface LifecycleEmitter {
	readonly isOpen: boolean;
	on(event: "ready" | "reconnecting", listener: () => void): unknown;
	on(event: "error", listener: (error: unknown) => void): unknown;
}

export class ClientLifecycle {
	private connected = false;
	private abandoned = false;

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
		client.on("error", (error) => {
			if (client.isOpen) return;
			if (this.abandoned) return;

			this.abandoned = true;
			this.probe.connectionAbandoned(error);
		});
	}
}
