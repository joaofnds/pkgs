import { EventEmitter2 } from "@nestjs/event-emitter";
import { Test, TestingModule } from "@nestjs/testing";
import { StreamsConnectorModule, StreamsConnectorOptions } from "../src";
import { Options } from "../src/types";

export class FakeApp {
  app?: TestingModule;
  received: any[] = [];
  name: string;
  send: string;
  receive: string;
  eventEmitter: EventEmitter2;
  options: Options;

  constructor({
    name,
    send,
    receive,
    eventEmitter,
  }: {
    name: string;
    send: string;
    receive: string;
    eventEmitter: EventEmitter2;
  }) {
    this.name = name;
    this.send = send;
    this.receive = receive;
    this.eventEmitter = eventEmitter;

    this.options = {
      eventEmitter: this.eventEmitter,
      redis: { name: this.name },
      stream: {
        group: "fake-app-" + this.name,
        consumer: "fake-app-consumer-" + this.name,
        readTimeout: 100,
        maxLen: 1,
        deadMaxLen: 1,
      },
      reclaim: {
        interval: 100,
        count: 10,
        throughputThreshold: 10,
        minIdleTime: 100,
        maxDeliveries: 10,
      },
      sendEvents: [{ name: this.send, serialize: (a) => a }],
      receiveEvents: [{ name: this.receive, deserialize: (a) => a }],
    };
  }

  async start() {
    const module = await Test.createTestingModule({
      imports: [
        StreamsConnectorModule.registerAsync({
          useFactory: () => new StreamsConnectorOptions(this.options),
        }),
      ],
    }).compile();

    this.app = await module.init();

    this.eventEmitter.on(this.receive, async (args) => {
      try {
        await this.handle(args);
      } catch (error) {
        this.eventEmitter.emit("failed");
        throw error;
      }
    });
  }

  async stop() {
    await this.app?.close();
  }

  async emit(args: any) {
    await this.eventEmitter.emitAsync(this.send, args);
  }

  async handle(args: any) {
    this.received.push({ event: this.receive, args });
  }
}
