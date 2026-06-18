import type { QueryClient } from "@tanstack/react-query";
import type {
	ProfileAnalysisContext,
	ProfileAnalysisRunResult,
} from "#/lib/profile-analysis";
import { responseError } from "#/lib/client-http";
import {
	PROFILE_HYDRATION_BATCH_LIMIT,
	hydrateProfileHandles,
	normalizeProfileHydrationHandle,
} from "#/lib/profile-hydration-client";
import type { ProfileRecord } from "#/lib/types";

export interface ProfileAnalysisRequestOptions {
	refresh: boolean;
	maxTweets: number;
	maxPages: number;
	maxConversations: number;
	maxConversationPages: number;
}

export const DEFAULT_PROFILE_ANALYSIS_LIMITS = {
	maxTweets: 10000,
	maxPages: 100,
	maxConversations: 80,
	maxConversationPages: 3,
} as const;

const PROFILE_MENTION_RE = /(^|[^\w@./])@([A-Za-z0-9_]{1,15})\b/g;

export const normalizeProfileHandle = normalizeProfileHydrationHandle;

export function handlesFromText(value: string) {
	return Array.from(value.matchAll(PROFILE_MENTION_RE)).map(
		(match) => match[2],
	);
}

export function knownProfileHandles(context: ProfileAnalysisContext) {
	const handles = new Set<string>();
	handles.add(normalizeProfileHandle(context.profile.handle));
	for (const profile of context.profiles ?? []) {
		handles.add(normalizeProfileHandle(profile.handle));
	}
	for (const tweet of context.conversations) {
		handles.add(normalizeProfileHandle(tweet.author));
	}
	return handles;
}

export function collectProfileAnalysisHydrationHandles({
	context,
	analysis,
	markdown,
}: {
	context: ProfileAnalysisContext;
	analysis?: ProfileAnalysisRunResult["analysis"];
	markdown?: string;
}) {
	const handles = new Set<string>();
	const known = knownProfileHandles(context);
	const add = (value: string | undefined) => {
		if (!value) return;
		const handle = normalizeProfileHandle(value);
		if (!/^[a-z0-9_]{1,15}$/.test(handle) || known.has(handle)) return;
		handles.add(handle);
	};

	for (const handle of analysis?.sourceHandles ?? []) add(handle);
	for (const theme of analysis?.themes ?? []) {
		for (const handle of theme.handles) add(handle);
	}
	if (markdown) {
		for (const handle of handlesFromText(markdown)) add(handle);
	}
	for (const handle of handlesFromText(context.profile.bio)) add(handle);
	for (const tweet of context.tweets) {
		for (const handle of handlesFromText(tweet.text)) add(handle);
	}
	for (const tweet of context.conversations) {
		for (const handle of handlesFromText(tweet.text)) add(handle);
		for (const handle of handlesFromText(tweet.bio)) add(handle);
	}

	return [...handles];
}

export function applyHydratedProfilesToProfileAnalysisContext(
	context: ProfileAnalysisContext,
	profiles: ProfileRecord[],
) {
	const existing = new Map<string, ProfileRecord>();
	for (const profile of context.profiles ?? []) {
		existing.set(normalizeProfileHandle(profile.handle), profile);
	}
	for (const profile of profiles) {
		existing.set(normalizeProfileHandle(profile.handle), profile);
	}
	return {
		...context,
		profiles: [...existing.values()],
	};
}

export async function hydrateProfileAnalysisProfiles({
	queryClient,
	context,
	analysis,
	markdown,
}: {
	queryClient: QueryClient;
	context: ProfileAnalysisContext;
	analysis?: ProfileAnalysisRunResult["analysis"];
	markdown?: string;
}) {
	const handles = collectProfileAnalysisHydrationHandles({
		context,
		analysis,
		markdown,
	});
	const { profiles } = await hydrateProfileHandles(queryClient, handles, {
		limit: PROFILE_HYDRATION_BATCH_LIMIT,
	});
	return profiles;
}

export function profileAnalysisUrl(
	handle: string,
	options: ProfileAnalysisRequestOptions,
) {
	const params = new URLSearchParams();
	params.set("handle", handle);
	params.set("maxTweets", String(options.maxTweets));
	params.set("maxPages", String(options.maxPages));
	params.set("maxConversations", String(options.maxConversations));
	params.set("maxConversationPages", String(options.maxConversationPages));
	if (options.refresh) {
		params.set("refresh", "true");
	}
	return `/api/profile-analysis?${params.toString()}`;
}

export async function profileAnalysisRequestError(response: Response) {
	return responseError(response, { label: "Profile analysis failed" });
}

export function formatProfileAnalysisCounts(
	context: ProfileAnalysisContext | null,
) {
	if (!context) return "xurl profile backfill with cached AI analysis.";
	return [
		context.fetchCached ? "cached backfill" : "fresh xurl backfill",
		`${String(context.counts.tweets)} tweets`,
		`${String(context.counts.conversationTweets)} conversation tweets`,
		`${String(context.counts.conversationsScanned)} conversations`,
	].join(" · ");
}

export function cleanProfileHandle(value: string) {
	return value.trim().replace(/^@/, "");
}
