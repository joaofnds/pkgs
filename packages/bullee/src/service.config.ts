import { Injectable } from "@nestjs/common";
import Bull from "bull";

@Injectable()
export class BulleeServiceConfig {
	constructor(
		readonly enableListeners: boolean,
		readonly enableWorkers: boolean,
		readonly job: Bull.JobOptions,
		readonly redis: { host: string; port: number },
	) {}

	static withDefaults(config: Partial<BulleeServiceConfig>) {
		const withDefaults = Object.assign(
			{},
			{
				enableListeners: true,
				enableWorkers: true,
				job: {
					attempts: 5,
					backoff: { type: "exponential", delay: 2 * 1000 },
					removeOnComplete: { age: 7 * 24 * 60 * 60 },
				},
				redis: { host: "localhost", port: 6379 },
			},
			config,
		);

		return new BulleeServiceConfig(
			withDefaults.enableListeners,
			withDefaults.enableWorkers,
			withDefaults.job,
			withDefaults.redis,
		);
	}
}
