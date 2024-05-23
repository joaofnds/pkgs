import { Queue } from "bullmq";
import { BeeService } from "./service";

export class BulleTesting {
	constructor(private readonly service: BeeService) {}

	async cleanAllQueues() {
		await Promise.all(
			this.service
				.getQueues()
				.map((queue) => queue.obliterate({ force: true })),
		);
	}

	async pauseAllQueues() {
		await Promise.all(this.service.getQueues().map((queue) => queue.pause()));
	}

	async resumeAllQueues() {
		await Promise.all(this.service.getQueues().map((queue) => queue.resume()));
	}

	async drainQueue(queue: Queue) {
		await queue.resume();
		while (
			(await queue.getJobCountByTypes("active", "delayed", "waiting")) > 0
		) {}
		await queue.pause();
	}
}
