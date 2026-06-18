// Pure reporting helpers: percentiles, Redis commandstats parsing, table render.

export function percentile(values: number[], q: number): number {
	if (values.length === 0) return Number.NaN;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = q * (sorted.length - 1);
	const lo = Math.floor(rank);
	const hi = Math.ceil(rank);
	if (lo === hi) return sorted[lo];
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

export interface CommandStats {
	readonly total: number;
	readonly lua: number;
	readonly byCommand: ReadonlyMap<string, number>;
}

// Control-plane commands excluded from the data-plane total so "commands per
// message" reflects the messaging work, not connection/inspection chatter.
const CONTROL = new Set([
	"info",
	"config",
	"client",
	"hello",
	"command",
	"auth",
	"ping",
	"flushall",
	"select",
]);
const LUA = new Set(["eval", "evalsha", "fcall", "fcall_ro", "function"]);

// Parses `INFO commandstats` lines: `cmdstat_xadd:calls=10000,usec=...`.
export function parseCommandStats(info: string): CommandStats {
	const byCommand = new Map<string, number>();
	let total = 0;
	let lua = 0;
	for (const line of info.split(/\r?\n/)) {
		const match = line.match(/^cmdstat_([a-z0-9_|]+):calls=(\d+)/i);
		if (match === null) continue;
		const command = match[1].toLowerCase();
		const calls = Number(match[2]);
		const head = command.split("|")[0];
		if (CONTROL.has(head)) continue;
		byCommand.set(command, calls);
		total += calls;
		if (LUA.has(head)) lua += calls;
	}
	return { total, lua, byCommand };
}

export function table(headers: string[], rows: string[][]): string {
	const widths = headers.map((h, i) =>
		Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
	);
	const render = (cells: string[]) =>
		cells.map((c, i) => (c ?? "").padStart(widths[i])).join("  ");
	const line = widths.map((w) => "─".repeat(w)).join("  ");
	return [render(headers), line, ...rows.map(render)].join("\n");
}

export function num(n: number): string {
	return Number.isFinite(n) ? Math.round(n).toLocaleString() : "—";
}

export function fixed(n: number, digits = 2): string {
	return Number.isFinite(n) ? n.toFixed(digits) : "—";
}
