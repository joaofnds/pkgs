// Shared contract between the saturation orchestrator (saturation.ts) and the
// load workers (sat-worker.ts). Workers receive a WorkerConfig as workerData and
// exchange WorkerToMain / MainToWorker messages over the thread port.

export type SystemKind = "redis" | "nats";

export interface WorkerConfig {
	readonly role: "producer" | "consumer";
	readonly system: SystemKind;
	readonly url: string;
	readonly topic: string;
	readonly subName: string;
	readonly payload: number;
	readonly readCount: number;
	readonly pubInflight: number;
	readonly consumerName: string;
}

export type MainToWorker =
	| { readonly type: "pause" }
	| { readonly type: "resume" }
	| { readonly type: "stop" };

export type WorkerToMain =
	| { readonly type: "ready" }
	| {
			readonly type: "stat";
			readonly published: number;
			readonly processed: number;
			readonly t: number;
	  }
	| { readonly type: "stopped" }
	| { readonly type: "error"; readonly message: string };
