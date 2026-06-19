function parts(id: string): [bigint, bigint] {
	const [ms, seq] = id.split("-");
	return [BigInt(ms), seq === undefined ? 0n : BigInt(seq)];
}

export function compareStreamIds(a: string, b: string): number {
	const [aMs, aSeq] = parts(a);
	const [bMs, bSeq] = parts(b);
	if (aMs !== bMs) return aMs < bMs ? -1 : 1;
	if (aSeq !== bSeq) return aSeq < bSeq ? -1 : 1;
	return 0;
}

export function minStreamId(ids: readonly string[]): string {
	return ids.reduce((min, id) => (compareStreamIds(id, min) < 0 ? id : min));
}
