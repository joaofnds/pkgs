import { createClient, RESP_TYPES } from "redis";
import {
	RedisStreamsBroker,
	RedisStreamsBrokerOptions,
	ResolvedOptions,
} from "../../src/redis";

export const REDIS_URL = "redis://localhost:6381";

const TEST_RECLAIM = {
	interval: 50,
	minIdleTime: 50,
	count: 100,
	throughputThreshold: 1_000_000,
};

function maintClient() {
	return createClient({ url: REDIS_URL, RESP: 2 }).withTypeMapping({
		[RESP_TYPES.BLOB_STRING]: Buffer,
	});
}

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

	async groupNames(stream: string): Promise<string[]> {
		const groups = await this.maint.xInfoGroups(stream);
		return groups.map((group) => String(group.name));
	}

	async keyExists(key: string): Promise<boolean> {
		return (await this.maint.exists(key)) > 0;
	}

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

export type { ResolvedOptions };
