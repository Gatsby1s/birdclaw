export type DiscussDateRange = "all" | "today" | "24h" | "yesterday" | "week";

export interface ResolvedDiscussDateRange {
	since?: string;
	until?: string;
}

function localDateStart(date: Date) {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number) {
	const next = new Date(date);
	next.setDate(next.getDate() + days);
	return next;
}

export function resolveDiscussDateRange(
	range: DiscussDateRange,
	now = new Date(),
): ResolvedDiscussDateRange {
	if (range === "all") return {};

	if (range === "today") {
		return {
			since: localDateStart(now).toISOString(),
			until: now.toISOString(),
		};
	}

	if (range === "yesterday") {
		const today = localDateStart(now);
		return {
			since: addDays(today, -1).toISOString(),
			until: today.toISOString(),
		};
	}

	if (range === "24h") {
		return {
			since: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
			until: now.toISOString(),
		};
	}

	return {
		since: addDays(now, -7).toISOString(),
		until: now.toISOString(),
	};
}
