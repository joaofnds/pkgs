// Redis Stream ids are `<ms>-<seq>` (e.g. "1718000000000-0"). The MINID reaper
// (PRD §8) needs the minimum id across consumer groups to know how far a live
// topic stream is safe to trim, so it must order ids correctly. ms can exceed
// Number.MAX_SAFE_INTEGER in principle, so compare with BigInt rather than parse
// to a float and risk precision loss.
function parts(id: string): [bigint, bigint] {
	const [ms, seq] = id.split("-");
	return [BigInt(ms), seq === undefined ? 0n : BigInt(seq)];
}

// Negative when a < b, 0 when equal, positive when a > b — ms dominates, the
// sequence breaks ties within the same millisecond.
export function compareStreamIds(a: string, b: string): number {
	const [aMs, aSeq] = parts(a);
	const [bMs, bSeq] = parts(b);
	if (aMs !== bMs) return aMs < bMs ? -1 : 1;
	if (aSeq !== bSeq) return aSeq < bSeq ? -1 : 1;
	return 0;
}

// The smallest id in a non-empty list. Callers must not pass an empty list:
// there is no meaningful minimum, and trimming against it would be a bug.
export function minStreamId(ids: readonly string[]): string {
	return ids.reduce((min, id) => (compareStreamIds(id, min) < 0 ? id : min));
}
