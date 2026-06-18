import { ProbeLogger } from "./probe-logger";

// Default sink: one JSON line per event on the matching console stream. Real
// deployments inject their own ProbeLogger; this keeps the out-of-the-box
// production impl useful and dependency-free.
export class ConsoleProbeLogger implements ProbeLogger {
	info(event: string, fields: Record<string, unknown>): void {
		console.info(JSON.stringify({ event, ...fields }));
	}

	error(event: string, fields: Record<string, unknown>): void {
		console.error(JSON.stringify({ event, ...fields }));
	}
}
