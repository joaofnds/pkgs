import { Injectable, OnModuleInit } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import Bull from "bull";
import { registeredEvents } from "./decorator";
import { BulleeServiceConfig } from "./service.config";
import { BulleeEvent } from "./types";

@Injectable()
export class BulleeService implements OnModuleInit {
	private readonly eventQueue = new Map<string, Bull.Queue>();

	constructor(
		private readonly config: BulleeServiceConfig,
		private readonly eventEmitter: EventEmitter2,
	) {}

	onModuleInit() {
		this.setupQueues();
		if (this.config.enableListeners) this.setupListeners();
		if (this.config.enableWorkers) this.setupWorkers();
	}

	getQueue(event: string) {
		const queue = this.eventQueue.get(event);

		if (!queue) throw new Error(`queue for event ${event} not found`);

		return queue;
	}

	getQueues() {
		return Array.from(this.eventQueue.values());
	}

	private setupQueues() {
		for (const event of registeredEvents.keys()) {
			this.eventQueue.set(
				event,
				new Bull(event, {
					defaultJobOptions: this.config.job,
					redis: this.config.redis,
				}),
			);
		}
	}

	private setupWorkers() {
		for (const [event, listeners] of registeredEvents) {
			for (const listener of listeners) {
				const aliases = (listener.options?.aliases || []).concat(listener.name);
				for (const alias of aliases) {
					this.getQueue(event)?.process(
						alias,
						async (job: Bull.Job<BulleeEvent>) => {
							return await this.eventEmitter.emitAsync(
								listener.backgroundEvent,
								job.data.payload,
							);
						},
					);
				}
			}
		}
	}

	private setupListeners() {
		for (const [event, listeners] of registeredEvents) {
			for (const listener of listeners) {
				this.eventEmitter.on(event, async (payload) => {
					await this.getQueue(event).add(
						listener.name,
						{ event: listener.backgroundEvent, payload },
						Object.assign({}, this.config.job, listener.options?.job),
					);
				});
			}
		}
	}
}
