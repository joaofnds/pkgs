import { ProbeLogger } from "./probe-logger";

export class ConsoleProbeLogger implements ProbeLogger {
	info(event: string, fields: Record<string, unknown>): void {
		console.info(JSON.stringify({ event, ...fields }));
	}

	error(event: string, fields: Record<string, unknown>): void {
		console.error(JSON.stringify({ event, ...fields }));
	}
}
