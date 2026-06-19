import { beforeEach, describe, expect, it } from "vitest";
import { AckBatch } from "./ack-batch";

describe("AckBatch", () => {
	let batch: AckBatch;

	beforeEach(() => {
		batch = new AckBatch();
	});

	it("reports empty until an id is added", () => {
		expect(batch.isEmpty()).toBe(true);

		batch.add("1-0");

		expect(batch.isEmpty()).toBe(false);
	});

	it("accumulates added ids in order", () => {
		batch.add("1-0");
		batch.add("2-0");

		expect(batch.ids).toEqual(["1-0", "2-0"]);
	});

	it("hands every adder the same shared promise", () => {
		const first = batch.add("1-0");
		const second = batch.add("2-0");

		expect(second).toBe(first);
	});

	it("resolves every adder's promise on resolve", async () => {
		const settled = [batch.add("1-0"), batch.add("2-0")];

		batch.resolve();

		await expect(Promise.all(settled)).resolves.toEqual([undefined, undefined]);
	});

	it("rejects every adder's promise with the error on reject", async () => {
		const error = new Error("xack failed");
		const settled = Promise.allSettled([batch.add("1-0"), batch.add("2-0")]);

		batch.reject(error);

		expect(await settled).toEqual([
			{ status: "rejected", reason: error },
			{ status: "rejected", reason: error },
		]);
	});
});
