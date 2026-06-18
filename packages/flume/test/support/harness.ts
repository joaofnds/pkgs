import { createClient, RESP_TYPES } from "redis";
import {
	RedisStreamsBroker,
	RedisStreamsBrokerOptions,
	ResolvedOptions,
} from "../../src/redis";

export const REDIS_URL = "redis://localhost:6381";

// Fast reclaim timings so a failing message cycles through retries and
// dead-letter within a test's patience, and a high throughput threshold so the
// reclaim loop is never gated off (we always want redelivery in tests). minIdleTime
// stays well above the (instant) test handler duration so reclaim never steals an
// in-flight message.
const TEST_RECLAIM = {
	interval: 50,
	minIdleTime: 50,
	count: 100,
	throughputThreshold: 1_000_000,
};

// A binary-clean client for test assertions (XRANGE/XLEN/XPENDING/FLUSHALL). Reads
// blob replies as Buffer so the harness can parse binary dead-letter frames.
function maintClient() {
	return createClient({ url: REDIS_URL, RESP: 2 }).withTypeMapping({
		[RESP_TYPES.BLOB_STRING]: Buffer,
	});
}

// Lifecycle wrapper (GOOS Harness): builds a connected broker and a maintenance
// client, and tears both down. Tests construct the application through this, never
// by hand-wiring clients.
export class BrokerHarness {
	private constructor(
		readonly broker: RedisStreamsBroker,
		readonly maint: ReturnType<typeof maintClient>,
	) {}

	static async start(
		overrides: Partial<RedisStreamsBrokerOptions> = {},
	): Promise<BrokerHarness> {
		const maint = maintClient();
		await maint.connect();

		const broker = new RedisStreamsBroker({
			redis: { url: REDIS_URL },
			readTimeout: 100,
			reclaim: TEST_RECLAIM,
			...overrides,
		});
		await broker.connect();
		return new BrokerHarness(broker, maint);
	}

	async stop(): Promise<void> {
		await this.broker.close();
		await this.maint.close();
	}

	// Pending-entry delivery count for one message id (the broker-tracked attempt
	// count). 0 when the id is no longer pending (acked).
	async pendingCount(
		stream: string,
		group: string,
		id: string,
	): Promise<number> {
		const pending = await this.maint.xPendingRange(stream, group, id, id, 1);
		return pending.length > 0 ? pending[0].deliveriesCounter : 0;
	}

	async streamLength(stream: string): Promise<number> {
		return this.maint.xLen(stream);
	}

	// Consumer-group names on a stream (the maint client maps blobs to Buffer, so
	// names come back as Buffer — normalize to string).
	async groupNames(stream: string): Promise<string[]> {
		const groups = await this.maint.xInfoGroups(stream);
		return groups.map((group) => String(group.name));
	}

	async keyExists(key: string): Promise<boolean> {
		return (await this.maint.exists(key)) > 0;
	}

	// Seed a frozen orphan broadcast group: a per-instance group registered in the
	// broadcast registry but WITHOUT a liveness key — i.e. what a dead instance
	// leaves behind. The reaper must destroy it (and stop it pinning the MINID).
	async seedOrphanBroadcastGroup(
		stream: string,
		group: string,
		startId = "0",
	): Promise<void> {
		try {
			await this.maint.xGroupCreate(stream, group, startId, { MKSTREAM: true });
		} catch (error) {
			if (!(error instanceof Error) || !error.message.includes("BUSYGROUP")) {
				throw error;
			}
		}
		await this.maint.sAdd(`flume:bcast:${stream}`, group);
	}

	async registryMembers(stream: string): Promise<string[]> {
		const members = await this.maint.sMembers(`flume:bcast:${stream}`);
		return members.map((member) => String(member));
	}

	// Raw entries on a stream (e.g. the dead-letter stream) for assertions. The
	// payload field decodes to a Buffer (binary-clean).
	async entries(
		stream: string,
	): Promise<Array<{ id: string; payload: Buffer }>> {
		const range = await this.maint.xRange(stream, "-", "+");
		return range.map((entry) => ({
			id: entry.id.toString(),
			payload: entry.message.payload,
		}));
	}
}

// The fully-resolved options a broker runs on, exposed for tests that need the
// computed consumer name / defaults without reaching into the broker.
export type { ResolvedOptions };
