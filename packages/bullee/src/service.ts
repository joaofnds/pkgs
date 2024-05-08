import assert from "node:assert";
import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { Queue, Worker } from "bullmq";
import { Listener } from "eventemitter2";
import { BulleeConfig } from "./config";
import { registry } from "./decorator";

@Injectable()
export class BulleeService implements OnModuleInit, OnModuleDestroy {
	private readonly queues = new Map<string, Queue>();
	private readonly workers = new Map<string, Worker>();
	private readonly listeners: Listener[] = [];

	constructor(
		private readonly config: BulleeConfig,
		private readonly eventEmitter: EventEmitter2,
	) {}

	async onModuleInit() {
		this.setupQueues();

		if (this.config.enableListeners) this.setupListeners();
		if (this.config.enableWorkers) this.setupWorkers();
	}

	async onModuleDestroy() {
		await this.teardownQueues();

		if (this.config.enableListeners) this.teardownListeners();
		if (this.config.enableWorkers) await this.teardownWorkers();
	}

	getQueue(event: string) {
		const queue = this.queues.get(event);
		if (!queue) {
			throw new Error(`Queue for event ${event} not found`);
		}
		return queue;
	}

	getQueues() {
		return Array.from(this.queues.values());
	}

	private setupQueues() {
		for (const event of registry.events()) {
			const queue = new Queue(event, { connection: this.config.redisOptions });
			this.queues.set(event, queue);
		}
	}

	private async teardownQueues() {
		for (const queue of this.queues.values()) {
			await queue.close();
		}
	}

	private setupListeners() {
		for (const event of registry.events()) {
			const queue = this.getQueue(event);
			const listeners = registry.eventListeners(event);

			const eventListener = this.eventEmitter.on(
				event,
				async (payload) => {
					await queue.addBulk(
						listeners.map((listener) => ({
							name: listener.target,
							data: { targetedEvent: listener.targetedEvent, payload },
							opts: Object.assign(
								{},
								this.config.defaultJobOptions,
								listener.options?.job,
							),
						})),
					);
				},
				{ async: false, promisify: true, objectify: true },
			) as Listener;

			this.listeners.push(eventListener);
		}
	}

	private teardownListeners() {
		for (const listener of this.listeners) {
			listener.off();
		}
	}

	private setupWorkers() {
		for (const event of registry.events()) {
			const worker = new Worker(
				event,
				async ({ data: { targetedEvent, payload } }) => {
					assert(this.eventEmitter.listenerCount(targetedEvent) > 0);

					return await this.eventEmitter.emitAsync(targetedEvent, payload);
				},
				{ connection: this.config.redisOptions },
			);
			this.workers.set(event, worker);
		}
	}

	private async teardownWorkers() {
		for (const worker of this.workers.values()) {
			await worker.close();
		}
	}
}
