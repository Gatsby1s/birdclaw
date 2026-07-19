export interface CustomDateRange {
	since: string;
	until: string;
}

export function normalizeCustomDateRange(
	sinceValue: string | undefined,
	untilValue: string | undefined,
): CustomDateRange | null {
	if (!sinceValue?.trim() || !untilValue?.trim()) return null;

	const since = new Date(sinceValue);
	const until = new Date(untilValue);
	if (
		Number.isNaN(since.getTime()) ||
		Number.isNaN(until.getTime()) ||
		since.getTime() >= until.getTime()
	) {
		return null;
	}

	return {
		since: since.toISOString(),
		until: until.toISOString(),
	};
}

export function defaultCustomDateRange(now = new Date()): CustomDateRange {
	return {
		since: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
		until: now.toISOString(),
	};
}

export function dateTimeLocalValue(value: string) {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "";
	const pad = (part: number) => String(part).padStart(2, "0");
	return [
		date.getFullYear(),
		"-",
		pad(date.getMonth() + 1),
		"-",
		pad(date.getDate()),
		"T",
		pad(date.getHours()),
		":",
		pad(date.getMinutes()),
	].join("");
}
