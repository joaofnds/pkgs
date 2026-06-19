import { brokerContractTests } from "@joaofnds/flume-tck";
import { NatsStreamsBroker } from "../src/index";

const NATS_URL = "nats://localhost:4223";

brokerContractTests<NatsStreamsBroker>("NatsStreamsBroker", {
	capabilities: {
		redelivery: true,
		startFromBeginning: true,
		broadcast: true,
		redrive: false,
	},
	async makeBroker(options) {
		const broker = new NatsStreamsBroker({
			nats: { servers: NATS_URL },
			instanceId: options?.instanceId,
			ackWait: 2000,
		});
		await broker.connect();
		return broker;
	},
	closeBroker: (broker) => broker.close(),
});
