import { INestApplication, Injectable } from "@nestjs/common";
import { EventEmitter2, EventEmitterModule } from "@nestjs/event-emitter";
import { Test } from "@nestjs/testing";
import { Queue } from "bullmq";
import { BeeModule, BeeService, OnBackgroundEvent } from "../src";
import { BulleTesting } from "../src/testing";

describe(BeeModule.name, () => {
	const testEventName = "test.event";

	let app: INestApplication;
	let emitter: TestEmitter;
	let listenerOne: TestListener;
	let listenerTwo: TestListener;
	let queue: Queue;
	let testing: BulleTesting;

	beforeAll(async () => {
		const module = await Test.createTestingModule({
			imports: [
				EventEmitterModule.forRoot({ wildcard: true }),
				BeeModule.forRoot({
					redisOptions: { host: "localhost", port: 6380 },
				}),
			],
			providers: [TestEmitter, TestListenerOne, TestListenerTwo],
		}).compile();

		app = module.createNestApplication();
		app.enableShutdownHooks();

		await app.init();

		emitter = app.get(TestEmitter);
		listenerOne = app.get(TestListenerOne);
		listenerTwo = app.get(TestListenerTwo);
		const service = app.get(BeeService);
		testing = new BulleTesting(service);
		queue = service.getQueue(testEventName);
	});

	beforeEach(async () => {
		listenerOne.clear();
		listenerTwo.clear();
		await testing.cleanAllQueues();
		await testing.pauseAllQueues();
	});

	afterAll(async () => {
		await app.close();
	});

	it("only calls listener when the job executes", async () => {
		await emitter.emit({ foo: "bar" });
		await emitter.emit({ bar: "baz" });
		await emitter.emit({ baz: "qux" });

		expect(await queue.getJobs("paused")).not.toHaveLength(0);
		expect(listenerOne.receivedEvents.length).toBe(0);
		expect(listenerTwo.receivedEvents.length).toBe(0);

		await testing.drainQueue(queue);

		expect(await queue.getJobs("paused")).toHaveLength(0);
		expect(listenerOne.receivedEvents.length).toBeGreaterThan(0);
		expect(listenerTwo.receivedEvents.length).toBeGreaterThan(0);
	});

	it("enqueues a job for each listener and emits them separately", async () => {
		await emitter.emit({ foo: "bar" });
		await emitter.emit({ bar: "baz" });
		await emitter.emit({ baz: "qux" });

		expect(await queue.getWaitingCount()).toEqual(6);

		expect(listenerOne.receivedEvents).toHaveLength(0);
		expect(listenerTwo.receivedEvents).toHaveLength(0);

		await testing.drainQueue(queue);

		expect(listenerOne.receivedEvents).toEqual([
			{ foo: "bar" },
			{ bar: "baz" },
			{ baz: "qux" },
		]);
		expect(listenerTwo.receivedEvents).toEqual([
			{ foo: "bar" },
			{ bar: "baz" },
			{ baz: "qux" },
		]);
	});

	describe("when a listener fails", () => {
		beforeEach(() => {
			listenerTwo.shouldFail = true;
		});

		it("does not affect the other listeners", async () => {
			await emitter.emit({ foo: "bar" });
			await emitter.emit({ bar: "baz" });
			await emitter.emit({ baz: "qux" });

			expect(await queue.getWaitingCount()).toEqual(6);

			expect(listenerOne.receivedEvents).toHaveLength(0);
			expect(listenerTwo.receivedEvents).toHaveLength(0);

			await testing.drainQueue(queue);

			expect(listenerOne.receivedEvents).toEqual([
				{ foo: "bar" },
				{ bar: "baz" },
				{ baz: "qux" },
			]);
			expect(listenerTwo.receivedEvents).toEqual([
				{ foo: "bar" },
				{ bar: "baz" },
				{ baz: "qux" },
				// retries
				{ foo: "bar" },
				{ bar: "baz" },
				{ baz: "qux" },
			]);

			expect(await queue.getJobCounts()).toEqual(
				expect.objectContaining({
					completed: 3, // for listener one
					failed: 3, // for listener two
				}),
			);
		});
	});

	describe("when all listeners fail", () => {
		beforeEach(() => {
			listenerOne.shouldFail = true;
			listenerTwo.shouldFail = true;
		});

		it("retries separately", async () => {
			await emitter.emit({ foo: "bar" });
			await emitter.emit({ bar: "baz" });
			await emitter.emit({ baz: "qux" });

			expect(await queue.getWaitingCount()).toEqual(6);

			expect(listenerOne.receivedEvents).toHaveLength(0);
			expect(listenerTwo.receivedEvents).toHaveLength(0);

			await testing.drainQueue(queue);

			expect(listenerOne.receivedEvents).toEqual([
				{ foo: "bar" },
				{ bar: "baz" },
				{ baz: "qux" },
				// retries
				{ foo: "bar" },
				{ bar: "baz" },
				{ baz: "qux" },
			]);
			expect(listenerTwo.receivedEvents).toEqual([
				{ foo: "bar" },
				{ bar: "baz" },
				{ baz: "qux" },
				// retries
				{ foo: "bar" },
				{ bar: "baz" },
				{ baz: "qux" },
			]);

			expect(await queue.getJobCounts()).toEqual(
				expect.objectContaining({
					completed: 0,
					failed: 6,
				}),
			);
		});
	});

	@Injectable()
	class TestEmitter {
		constructor(private readonly emitter: EventEmitter2) {}

		async emit(payload: unknown) {
			await this.emitter.emitAsync(testEventName, payload);
		}
	}

	class TestListener {
		readonly receivedEvents: unknown[] = [];
		shouldFail = false;

		handler(event: unknown) {
			this.receivedEvents.push(event);
			if (this.shouldFail) throw new Error("intended test failure");
		}

		clear() {
			this.shouldFail = false;
			this.receivedEvents.length = 0;
		}
	}

	@Injectable()
	class TestListenerOne extends TestListener {
		@OnBackgroundEvent(testEventName, { job: { attempts: 2, backoff: 0 } })
		handler(event: unknown) {
			super.handler(event);
		}
	}

	@Injectable()
	class TestListenerTwo extends TestListener {
		@OnBackgroundEvent(testEventName, { job: { attempts: 2, backoff: 0 } })
		handler(event: unknown) {
			super.handler(event);
		}
	}
});
