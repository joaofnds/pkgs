export interface ConsumerHandle {
	stop(): void;
	readonly stream: string;
	readonly group: string;
	readonly broadcast: boolean;
	throughputPerSecond(): number;
}

export class ConsumerRegistry {
	private readonly handles = new Set<ConsumerHandle>();

	get size(): number {
		return this.handles.size;
	}

	add(handle: ConsumerHandle): void {
		this.handles.add(handle);
	}

	stop(handle: ConsumerHandle): void {
		if (!this.handles.delete(handle)) return;
		handle.stop();
	}

	stopAll(): void {
		for (const handle of [...this.handles]) this.stop(handle);
	}

	[Symbol.iterator](): Iterator<ConsumerHandle> {
		return this.handles[Symbol.iterator]();
	}
}
