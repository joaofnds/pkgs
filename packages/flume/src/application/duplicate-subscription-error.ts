export class DuplicateSubscriptionError extends Error {
	constructor(
		readonly topic: string,
		readonly name: string,
	) {
		super(
			`a subscription for topic "${topic}" with name "${name}" is already registered`,
		);
		this.name = "DuplicateSubscriptionError";
	}
}
