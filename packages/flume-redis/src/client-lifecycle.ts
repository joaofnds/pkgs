import { BrokerProbe } from "./broker-probe";

export interface LifecycleEmitter {
	readonly isOpen: boolean;
	on(event: "ready" | "reconnecting", listener: () => void): unknown;
	on(event: "error", listener: (error: unknown) => void): unknown;
}

type ConnectionState = "idle" | "up" | "down";

export class ClientLifecycle {
	private state: ConnectionState = "idle";
	private abandoned = false;

	constructor(private readonly probe: BrokerProbe) {}

	watch(client: LifecycleEmitter): void {
		client.on("ready", () => {
			if (this.state === "idle") {
				this.state = "up";
				this.probe.connected();
				return;
			}

			this.state = "up";
			this.probe.reconnected();
		});
		client.on("reconnecting", () => {
			if (this.state === "down") return;

			this.state = "down";
			this.probe.disconnected();
		});
		client.on("error", (error) => {
			if (client.isOpen) return;
			if (this.state === "idle") return;
			if (this.abandoned) return;

			this.abandoned = true;
			this.probe.connectionAbandoned(error);
		});
	}
}
