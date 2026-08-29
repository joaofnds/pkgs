export interface ConsumerStall {
	readonly stream: string;
	readonly group: string;
	readonly consecutive: number;
	readonly error: unknown;
}
