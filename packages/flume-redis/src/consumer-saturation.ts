export interface ConsumerSaturation {
	readonly stream: string;
	readonly group: string;
	readonly streamDepth: number;
	readonly pendingCount: number;
	readonly consumerLag: number;
}
