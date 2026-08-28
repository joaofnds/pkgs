export interface ConsumerHandle {
	stop(): void;
	closed(): Promise<unknown>;
}

export class ConsumerRegistry {
	private readonly handles = new Set<ConsumerHandle>();

	get size(): number {
		return this.handles.size;
	}

	add(handle: ConsumerHandle): void {
		this.handles.add(handle);
		void handle.closed().then(() => this.handles.delete(handle));
	}

	stop(handle: ConsumerHandle): void {
		if (!this.handles.delete(handle)) return;
		handle.stop();
	}
}
