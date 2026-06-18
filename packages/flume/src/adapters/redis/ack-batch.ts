export class AckBatch {
	readonly ids: string[] = [];
	private readonly flushed: Promise<void>;
	private settle!: () => void;
	private fail!: (error: unknown) => void;

	constructor() {
		this.flushed = new Promise<void>((resolve, reject) => {
			this.settle = resolve;
			this.fail = reject;
		});
	}

	add(id: string): Promise<void> {
		this.ids.push(id);
		return this.flushed;
	}

	isEmpty(): boolean {
		return this.ids.length === 0;
	}

	resolve(): void {
		this.settle();
	}

	reject(error: unknown): void {
		this.fail(error);
	}
}
