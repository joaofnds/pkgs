// The named channel an event flows on (e.g. "user.created"). Value object,
// equality by name.
export class Topic {
	constructor(readonly name: string) {}

	equals(other: Topic): boolean {
		return this.name === other.name;
	}
}
