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
	});
});
