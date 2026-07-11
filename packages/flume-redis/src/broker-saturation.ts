import { ConsumerSaturation } from "./consumer-saturation";

export interface BrokerSaturation {
	readonly throughputPerSecond: number;
	readonly consumers: readonly ConsumerSaturation[];
}
