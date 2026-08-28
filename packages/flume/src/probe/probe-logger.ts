/**
 * A member reporting impact on the system (a symptom) logs at {@link error}.
 * A member reporting a fault flume is working around on its own (a cause) may
 * log at {@link warn} only when the impact it can produce reaches an
 * error-level symptom event on a path nameable in the source; otherwise it
 * stays at {@link error}.
 */
export interface ProbeLogger {
	/** Expected progress. No operator response. */
	info(event: string, fields: Record<string, unknown>): void;
	/**
	 * A cause flume is working around on its own, whose impact reaches an
	 * error-level symptom event on a path nameable in the source. Operator
	 * looks when convenient.
	 */
	warn(event: string, fields: Record<string, unknown>): void;
	/** A symptom, or a cause with no error-level symptom path. Operator acts now. */
	error(event: string, fields: Record<string, unknown>): void;
}
