// Competing: instances share one consumer group → each event processed once.
// Broadcast: per-instance group → every instance processes every event.
export enum DeliveryMode {
	Competing = "competing",
	Broadcast = "broadcast",
}
