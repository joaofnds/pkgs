import { describe, expect, it } from "vitest";
import { ConsumerHandle, ConsumerRegistry } from "./consumer-registry";

class FakeConsumerHandle implements ConsumerHandle {
	stopCalls = 0;
	private resolveClosed!: (value: unknown) => void;
	private readonly closedPromise = new Promise<unknown>((resolve) => {
		this.resolveClosed = resolve;
	});

	stop(): void {
		this.stopCalls += 1;
	}

	closed(): Promise<unknown> {
		return this.closedPromise;
	}

	terminate(): void {
		this.resolveClosed(undefined);
	}
}

describe(ConsumerRegistry, () => {
	describe("stop", () => {
		it("stops the consumer and drops its entry", () => {
			const registry = new ConsumerRegistry();
			const handle = new FakeConsumerHandle();
			registry.add(handle);

			registry.stop(handle);

			expect(handle.stopCalls).toBe(1);
			expect(registry.size).toBe(0);
		});

		describe("when a stop was already requested", () => {
			it("leaves the consumer's stop uncalled", () => {
				const registry = new ConsumerRegistry();
				const handle = new FakeConsumerHandle();
				registry.add(handle);
				registry.stop(handle);

				registry.stop(handle);

				expect(handle.stopCalls).toBe(1);
			});
		});

		describe("when the consumer already terminated on its own", () => {
			it("leaves the consumer's stop uncalled", async () => {
				const registry = new ConsumerRegistry();
				const handle = new FakeConsumerHandle();
				registry.add(handle);
				handle.terminate();
				await handle.closed();

				registry.stop(handle);

				expect(handle.stopCalls).toBe(0);
			});
		});
	});

	describe("add", () => {
		it("drops the entry when the consumer terminates on its own", async () => {
			const registry = new ConsumerRegistry();
			const handle = new FakeConsumerHandle();
			registry.add(handle);

			handle.terminate();
			await handle.closed();

			expect(registry.size).toBe(0);
		});
	});

	describe("stopAll", () => {
		it("stops every registered consumer and empties the registry", () => {
			const registry = new ConsumerRegistry();
			const handles = [
				new FakeConsumerHandle(),
				new FakeConsumerHandle(),
				new FakeConsumerHandle(),
			];
			for (const handle of handles) registry.add(handle);

			registry.stopAll();

			expect(registry.size).toBe(0);
			for (const handle of handles) expect(handle.stopCalls).toBe(1);
		});
	});
});
