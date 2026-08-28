export interface ConsumerStop {
	readonly stream: string;
	readonly group: string;
	readonly error: unknown;
}
