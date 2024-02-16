# Streams Connector

With streams connector you can make events from one event emitter instance to appear in another, through Redis Streams.

You can use that, for example, to communicate NestJS applications by just emitting events. Streams connector will take care of:

- On App A:
  - listening to the event
  - writing it to a stream
- On App B:
  - reading from the stream
  - publishing the event

![Screen Shot 2022-04-19 at 11 27 39 AM](https://user-images.githubusercontent.com/9938253/164041574-8f459d3a-e833-48fb-b945-3ec909431e32.png)

## Configuring

```ts
import {
  StreamsConnectorModule,
  StreamsConnectorOptions,
} from "@joaofnds/streams-connector";

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    StreamsConnectorModule.registerAsync({
      inject: [EventEmitter2],
      useFactory: (eventEmitter: EventEmitter2) => {
        return new StreamsConnectorOptions({
          eventEmitter,
          redis: {
            name: "myapp",
            url: "redis://localhost:6379",
          },
          stream: {
            group: "myapp",
            consumer: "myapp-consumer",
            readTimeout: 5000,
          },
          reclaim: {
            count: 10,
            interval: 60000,
            maxDeliveries: 5,
            throughputThreshold: 10,
            minIdleTime: 30000,
          },
          sendEvents: [
            {
              name: "my_event",
              serialize: (event) => JSON.stringify(event),
            },
          ],
          receiveEvents: [
            {
              name: "my_other_event",
              deserialize: (str) => JSON.parse(str),
            },
          ],
        });
      },
    }),
  ],
})
export class AppModule {}
```

If you want to now more about what each param means, please read the [redis streams doc](https://redis.io/docs/manual/data-types/streams/).

The reclaim will only happen when the throughput in below the provided threshold
