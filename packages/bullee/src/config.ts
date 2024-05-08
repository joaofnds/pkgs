import { Injectable } from "@nestjs/common";
import { JobsOptions, WorkerOptions } from "bullmq";
import { RedisOptions } from "ioredis";

type BulleeConfigConstructorParams = Partial<
	Pick<
		BulleeConfig,
		| "enableListeners"
		| "enableWorkers"
		| "defaultJobOptions"
		| "eventWorkerOptions"
	>
> &
	Pick<BulleeConfig, "redisOptions">;

@Injectable()
export class BulleeConfig {
	readonly enableListeners: boolean;
	readonly enableWorkers: boolean;
	readonly defaultJobOptions: JobsOptions;
	readonly eventWorkerOptions: Map<string, WorkerOptions>;
	readonly redisOptions: RedisOptions;

	constructor(config: BulleeConfigConstructorParams) {
		this.enableListeners = config.enableListeners ?? true;
		this.enableWorkers = config.enableWorkers ?? true;
		this.defaultJobOptions = {
			attempts: 5,
			backoff: { type: "exponential", delay: 2 * 1000 },
			removeOnComplete: { age: 7 * 24 * 60 * 60 },
			...config.defaultJobOptions,
		};
		this.eventWorkerOptions = new Map(config.eventWorkerOptions);
		this.redisOptions = config.redisOptions;
	}
}
