export function normalizeTimestampToIso(value: string) {
	const trimmed = value.trim();
	const parsed = new Date(trimmed);
	const time = parsed.getTime();
	return Number.isFinite(time) ? parsed.toISOString() : trimmed;
}
