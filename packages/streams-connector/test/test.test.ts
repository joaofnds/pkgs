import { EventEmitter2 } from "@nestjs/event-emitter";
import { StreamsConnectorModule } from "../src";
import { FakeApp } from "./fake-app";

describe(StreamsConnectorModule, () => {
  let appA: FakeApp;
  let appB: FakeApp;

  beforeEach(async () => {
    appA = new FakeApp({
      name: "a",
      send: "foo",
      receive: "bar",
      eventEmitter: new EventEmitter2(),
    });
    appB = new FakeApp({
      name: "b",
      send: "bar",
      receive: "foo",
      eventEmitter: new EventEmitter2(),
    });
    await Promise.all([appA.start(), appB.start()]);
  });

  afterEach(async () => {
    await Promise.all([appA.stop(), appB.stop()]);
  });

  it("events from one app are emitted in the other", async () => {
    appA.emit("A");
    await appB.eventEmitter.waitFor(appA.send);
    expect(appB.received).toContainEqual({ event: appA.send, args: "A" });

    appB.emit("B");
    await appA.eventEmitter.waitFor(appB.send);
    expect(appA.received).toContainEqual({ event: appB.send, args: "B" });
  });

  describe("when handler fails", () => {
    it("retries", async () => {
      const originalHandler = appB.handle;
      appB.handle = jest.fn(() => Promise.reject("oops"));

      appA.emit("A");
      await appB.eventEmitter.waitFor("failed");
      expect(appB.handle).toHaveBeenCalled();
      expect(appB.received).toHaveLength(0);

      appB.handle = originalHandler;
      await appB.eventEmitter.waitFor(appA.send);
      expect(appB.received).toContainEqual({ event: appA.send, args: "A" });
    });

    describe("when exceeds maxDeliveries", () => {
      it("is not delivered a again", async () => {
        appB.options.reclaim.maxDeliveries = 1;
        appB.handle = jest.fn(() => Promise.reject("oops"));

        appA.emit("A");
        await appB.eventEmitter.waitFor("dead:foo");
        expect(appB.handle).toHaveBeenCalledTimes(1);
      });
    });
  });
});
