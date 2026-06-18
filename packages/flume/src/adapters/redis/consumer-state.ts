import { Topic } from "../../domain/topic";
import { DeliveredMessage } from "../../ports/consumer";
import { ReadClient } from "./clients";

// One running blocking-read loop, bound to a single subscription's consumer
// group. Each subscription monopolizes its own read connection (a blocking
// XREADGROUP holds the socket), so this is `subscriptions + 2` connections per
// instance — the connection-cost ceiling called out in PRD §9.
export interface ConsumerState {
	readonly topic: Topic;
	readonly stream: string;
	readonly group: string;
	// Broadcast groups are per-instance and ephemeral: they heartbeat a TTL key and
	// are reaped when the instance dies. Competing groups are shared and stable, so
	// they neither heartbeat nor get reaped.
	readonly broadcast: boolean;
	readonly deliver: (msg: DeliveredMessage) => Promise<void>;
	readonly readClient: ReadClient;
	stopped: boolean;
}
