export class Topic {
	constructor(readonly name: string) {}

	equals(other: Topic): boolean {
		return this.name === other.name;
	}
}
