import {
	Injectable,
	OnApplicationBootstrap,
	OnApplicationShutdown,
} from "@nestjs/common";
import { createClient } from "redis";
import { StreamsConnectorOptions } from "./options";

@Injectable()
export class RedisConnection
	implements OnApplicationBootstrap, OnApplicationShutdown
{
	readonly readClient: ReturnType<typeof createClient>;
	readonly writeClient: ReturnType<typeof createClient>;
	readonly reclaimClient: ReturnType<typeof createClient>;

	constructor(options: StreamsConnectorOptions) {
		this.readClient = createClient(options.redis);
		this.writeClient = createClient(options.redis);
		this.reclaimClient = createClient(options.redis);
	}

	async onApplicationBootstrap() {
		await Promise.all([
			this.readClient.connect(),
			this.writeClient.connect(),
			this.reclaimClient.connect(),
		]);
	}

	async onApplicationShutdown() {
		await Promise.allSettled([
			this.readClient.quit(),
			this.writeClient.quit(),
			this.reclaimClient.quit(),
		]);
	}
}
