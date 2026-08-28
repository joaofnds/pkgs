import { describe, expect, it } from "vitest";
import { InvalidConcurrencyError } from "./invalid-concurrency-error";
import { NatsStreamsBroker } from "./nats-streams-broker";
import { NatsBrokerOptions, resolveOptions } from "./options";

const NATS: NatsBrokerOptions["nats"] = { servers: "localhost:4223" };

describe(resolveOptions, () => {
	it.for([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
		"rejects concurrency %j with a named error carrying the value",
		(concurrency) => {
			expect(() => resolveOptions({ nats: NATS, concurrency })).toThrow(
				new InvalidConcurrencyError(concurrency),
			);
		},
	);

	it("accepts a concurrency of 1", () => {
		expect(resolveOptions({ nats: NATS, concurrency: 1 }).concurrency).toBe(1);
	});

	it("defaults concurrency to 10", () => {
		expect(resolveOptions({ nats: NATS }).concurrency).toBe(10);
	});

	it("rejects an invalid concurrency at broker construction", () => {
		expect(() => new NatsStreamsBroker({ nats: NATS, concurrency: 0 })).toThrow(
			new InvalidConcurrencyError(0),
		);
	});

	it("no longer accepts readCount", () => {
		// @ts-expect-error readCount was replaced by concurrency
		const options: NatsBrokerOptions = { nats: NATS, readCount: 10 };
		expect(options).toBeDefined();
	});
});
