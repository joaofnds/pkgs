import { brokerContractTests } from "@joaofnds/flume-tck";
import { RedisStreamsBroker } from "../src/index";

const REDIS_URL = "redis://localhost:6381";
const TEST_RECLAIM = {
	interval: 50,
	minIdleTime: 50,
	count: 100,
	throughputThreshold: 1_000_000,
};
const FAST_BROADCAST = { heartbeatInterval: 25, heartbeatTtl: 100 };

brokerContractTests<RedisStreamsBroker>("RedisStreamsBroker", {
	capabilities: {
		redelivery: true,
		startFromBeginning: true,
		broadcast: true,
		redrive: true,
	},
	async makeBroker(options) {
		const broker = new RedisStreamsBroker({
			redis: { url: REDIS_URL },
			readTimeout: 100,
			reclaim: TEST_RECLAIM,
			broadcast: FAST_BROADCAST,
			reaper: { interval: 1000, trim: false },
			consumerName: options?.consumerName,
			instanceId: options?.instanceId,
		});
		await broker.connect();
		return broker;
	},
	closeBroker: (broker) => broker.close(),
	redrive: (broker, args) => broker.redriveDeadLetters(args),
});
