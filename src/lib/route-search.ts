import type { DiscussDateRange } from "./discuss-date-range";
import { normalizeCustomDateRange } from "./custom-date-range";
import type { NetworkMapKind } from "./network-map";
import type { SearchDiscussionSource } from "./search-discussion";
import type { TweetSearchMode } from "./tweet-search-live";
import type {
	InboxKind,
	LinkInsightKind,
	LinkInsightRange,
	LinkInsightSort,
	LinkInsightSource,
	ReplyFilter,
} from "./types";

function stringValue(value: unknown, fallback = "") {
	return typeof value === "string" ? value : fallback;
}

function enumValue<const T extends string>(
	value: unknown,
	values: readonly T[],
	fallback: T,
) {
	return typeof value === "string" && values.includes(value as T)
		? (value as T)
		: fallback;
}

function booleanValue(value: unknown, fallback = false) {
	if (value === true || value === "true" || value === "1") return true;
	if (value === false || value === "false" || value === "0") return false;
	return fallback;
}

export interface RouteSearchUpdateOptions {
	replace?: boolean;
}

export type RouteSearchChange<T> = (
	next: T,
	options?: RouteSearchUpdateOptions,
) => void;

export interface DmsRouteSearch {
	inbox: "all" | "accepted" | "requests";
	reply: ReplyFilter;
	minFollowers: string;
	minInfluence: string;
	sort: "recent" | "followers";
	q: string;
	conversation: string;
}

export function validateDmsSearch(
	search: Record<string, unknown>,
): DmsRouteSearch {
	return {
		inbox: enumValue(search.inbox, ["all", "accepted", "requests"], "all"),
		reply: enumValue(
			search.reply,
			["all", "unreplied", "replied"],
			"unreplied",
		),
		minFollowers: stringValue(search.minFollowers),
		minInfluence: stringValue(search.minInfluence),
		sort: enumValue(search.sort, ["recent", "followers"], "recent"),
		q: stringValue(search.q),
		conversation: stringValue(search.conversation),
	};
}

export interface InboxRouteSearch {
	kind: InboxKind;
	minScore: string;
	hideLowSignal: boolean;
}

export function validateInboxSearch(
	search: Record<string, unknown>,
): InboxRouteSearch {
	return {
		kind: enumValue(search.kind, ["mixed", "mentions", "dms"], "mixed"),
		minScore: stringValue(search.minScore, "40"),
		hideLowSignal: booleanValue(search.hideLowSignal, true),
	};
}

export interface LinksRouteSearch {
	kind: LinkInsightKind;
	range: LinkInsightRange;
	source: LinkInsightSource;
	sort: LinkInsightSort;
	q: string;
}

export function validateLinksSearch(
	search: Record<string, unknown>,
): LinksRouteSearch {
	return {
		kind: enumValue(search.kind, ["links", "videos"], "links"),
		range: enumValue(
			search.range,
			["today", "week", "month", "year", "all"],
			"week",
		),
		source: enumValue(search.source, ["all", "tweet", "dm"], "all"),
		sort: enumValue(search.sort, ["rank", "recent", "comments"], "rank"),
		q: stringValue(search.q),
	};
}

export interface DiscussRouteSearch {
	run: string;
	q: string;
	question: string;
	source: SearchDiscussionSource;
	mode: TweetSearchMode;
	range: DiscussDateRange;
	since: string;
	until: string;
	includeDms: boolean;
}

export function validateDiscussSearch(
	search: Record<string, unknown>,
): DiscussRouteSearch {
	const requestedRange = enumValue(
		search.range,
		["all", "today", "24h", "yesterday", "week", "custom"],
		"all",
	);
	const customRange = normalizeCustomDateRange(
		stringValue(search.since),
		stringValue(search.until),
	);
	return {
		run: stringValue(search.run),
		q: stringValue(search.q),
		question: stringValue(search.question),
		source: enumValue(
			search.source,
			["search", "all", "home", "mentions", "authored", "likes", "bookmarks"],
			"search",
		),
		mode: enumValue(search.mode, ["auto", "bird", "xurl", "local"], "xurl"),
		range: requestedRange === "custom" && !customRange ? "all" : requestedRange,
		since: customRange?.since ?? "",
		until: customRange?.until ?? "",
		includeDms: booleanValue(search.includeDms),
	};
}

export type PeriodRouteSearch =
	| "today"
	| "24h"
	| "yesterday"
	| "week"
	| "custom";

export interface TodayRouteSearch {
	period: PeriodRouteSearch;
	since: string;
	until: string;
	includeDms: boolean;
}

export function validateTodaySearch(
	search: Record<string, unknown>,
): TodayRouteSearch {
	const requestedPeriod = enumValue(
		search.period,
		["today", "24h", "yesterday", "week", "custom"],
		"today",
	);
	const customRange = normalizeCustomDateRange(
		stringValue(search.since),
		stringValue(search.until),
	);
	return {
		period:
			requestedPeriod === "custom" && !customRange ? "today" : requestedPeriod,
		since: customRange?.since ?? "",
		until: customRange?.until ?? "",
		includeDms: booleanValue(search.includeDms),
	};
}

export interface NetworkMapRouteSearch {
	type: NetworkMapKind;
	q: string;
}

export function validateNetworkMapSearch(
	search: Record<string, unknown>,
): NetworkMapRouteSearch {
	return {
		type: enumValue(
			search.type,
			["all", "followers", "following", "mutual"],
			"all",
		),
		q: stringValue(search.q),
	};
}

export interface BlocksRouteSearch {
	account: string;
	q: string;
}

export function validateBlocksSearch(
	search: Record<string, unknown>,
): BlocksRouteSearch {
	return {
		account: stringValue(search.account, "acct_primary"),
		q: stringValue(search.q),
	};
}
