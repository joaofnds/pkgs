// The sink a LoggingProbe writes to. An app injects its own structured logger
// (pino, winston, a metrics-emitting shim); the default writes JSON to the
// console. Kept tiny so it carries no dependency — Flume's core stays dep-free.
export interface ProbeLogger {
	info(event: string, fields: Record<string, unknown>): void;
	error(event: string, fields: Record<string, unknown>): void;
}
