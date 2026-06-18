import { queryKeys } from "#/lib/query-client";
import {
	linkInsightResponseSchema,
	type LinkInsightResponse,
} from "#/lib/api-contracts";
import { fetchJson } from "#/lib/api-client";
import type {
	LinkInsightItem,
	LinkInsightKind,
	LinkInsightMention,
	LinkInsightRange,
	LinkInsightSort,
	LinkInsightSource,
	ProfileRecord,
	TweetMediaItem,
} from "#/lib/types";

export const INITIAL_VISIBLE_COMMENTS = 3;
export const MORE_COMMENTS_BATCH = 6;
export const LINK_INSIGHTS_LIMIT = 30;
export const LINK_INSIGHTS_COMMENTS_LIMIT = 30;
export const PROFILE_HYDRATION_LIMIT = 30;
export const PROFILE_HYDRATION_DELAY_MS = 1200;
export const LINK_INSIGHTS_CACHE_MAX_AGE_MS = 5 * 60_000;

export const ranges: Array<{ value: LinkInsightRange; label: string }> = [
	{ value: "today", label: "Today" },
	{ value: "week", label: "Week" },
	{ value: "month", label: "Month" },
	{ value: "year", label: "Year" },
	{ value: "all", label: "All" },
];

export function itemTitle(item: LinkInsightItem) {
	return item.title?.trim() || item.displayUrl;
}

export function itemSubtitle(item: LinkInsightItem) {
	const description = item.description?.trim();
	if (description) {
		return description;
	}
	return item.displayUrl.split("?")[0] || item.displayUrl;
}

export function linkInsightQueryKey(
	kind: LinkInsightKind,
	range: LinkInsightRange,
	sort: LinkInsightSort,
	source: LinkInsightSource,
) {
	return [...queryKeys.linkInsights, { kind, range, sort, source }] as const;
}

export function linkInsightsUrl(
	kind: LinkInsightKind,
	range: LinkInsightRange,
	sort: LinkInsightSort,
	source: LinkInsightSource,
) {
	const url = new URL("/api/link-insights", window.location.origin);
	url.searchParams.set("kind", kind);
	url.searchParams.set("range", range);
	url.searchParams.set("sort", sort);
	url.searchParams.set("source", source);
	url.searchParams.set("limit", String(LINK_INSIGHTS_LIMIT));
	url.searchParams.set("commentsLimit", String(LINK_INSIGHTS_COMMENTS_LIMIT));
	return url;
}

export async function fetchLinkInsights(
	kind: LinkInsightKind,
	range: LinkInsightRange,
	sort: LinkInsightSort,
	source: LinkInsightSource,
	signal?: AbortSignal,
) {
	return fetchJson(
		linkInsightsUrl(kind, range, sort, source),
		{ signal },
		linkInsightResponseSchema,
		"Link insights unavailable",
	);
}

export function mentionHref(
	mention: LinkInsightMention,
	item: LinkInsightItem,
) {
	return mention.sourceUrl || mention.contentTweetUrl || item.url;
}

export function mentionCopy(mention: LinkInsightMention) {
	return (
		mention.commentText ||
		mention.sharedContentText ||
		mention.rawText ||
		"Shared without comment"
	);
}

export function isSameProfile(
	left: ProfileRecord | null | undefined,
	right: ProfileRecord | null | undefined,
) {
	return Boolean(left && right && left.id === right.id);
}

export function mediaImage(media: TweetMediaItem[]) {
	return media.find((item) => item.thumbnailUrl || item.url) ?? null;
}

export function youtubeVideoId(rawUrl: string) {
	try {
		const url = new URL(rawUrl);
		const host = url.hostname.toLowerCase().replace(/^www\./, "");
		if (host === "youtu.be") {
			return url.pathname.split("/").filter(Boolean)[0] ?? null;
		}
		if (!host.endsWith("youtube.com")) {
			return null;
		}
		if (url.pathname === "/watch") {
			return url.searchParams.get("v");
		}
		const parts = url.pathname.split("/").filter(Boolean);
		if (parts[0] === "embed" || parts[0] === "shorts" || parts[0] === "live") {
			return parts[1] ?? null;
		}
		return null;
	} catch {
		return null;
	}
}

export function youtubeThumbnailUrl(rawUrl: string) {
	const id = youtubeVideoId(rawUrl);
	if (!id || !/^[\w-]{6,}$/.test(id)) {
		return null;
	}
	return `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`;
}

export function commentCount(item: LinkInsightItem) {
	return (
		item.commentCount ??
		item.mentions.filter((mention) => mention.hasComment).length
	);
}

export function pureShareCount(item: LinkInsightItem) {
	return (
		item.pureShareCount ??
		item.mentions.filter(
			(mention) => mention.isPureShare || !mention.hasComment,
		).length
	);
}

export function isArchivePlaceholderProfile(profile: ProfileRecord) {
	return (
		/^id\d+$/i.test(profile.handle) &&
		profile.displayName === profile.handle &&
		profile.id === `profile_user_${profile.handle.slice(2)}`
	);
}

export function profileNeedsHydration(
	profile: ProfileRecord | null | undefined,
) {
	if (!profile?.handle || isArchivePlaceholderProfile(profile)) {
		return false;
	}
	return !profile.avatarUrl || profile.followersCount === 0;
}

export function collectProfilesForHydration(data: LinkInsightResponse | null) {
	const handles = new Set<string>();
	for (const item of data?.items ?? []) {
		for (const profile of [
			item.topSharer,
			...item.sharers,
			...item.mentions.flatMap((mention) => [
				mention.sharedBy,
				mention.contentAuthor,
				mention.participant,
			]),
		]) {
			if (!profile || !profileNeedsHydration(profile)) {
				continue;
			}
			handles.add(profile.handle.replace(/^@/, ""));
			if (handles.size >= PROFILE_HYDRATION_LIMIT) {
				return [...handles];
			}
		}
	}
	return [...handles];
}
