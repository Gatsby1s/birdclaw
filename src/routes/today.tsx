import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
	FileText,
	CheckCircle2,
	FileDown,
	History,
	Loader2,
	RefreshCw,
	Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { CustomDateRangePicker } from "#/components/CustomDateRangePicker";
import {
	DailyDigestHistoryPanel,
	type DailyDigestHistoryListItem,
} from "#/components/DailyDigestHistoryPanel";
import { MarkdownViewer } from "#/components/MarkdownViewer";
import { ReferencePrintMedia } from "#/components/ReferencePrintMedia";
import { useNdjsonRun } from "#/components/useNdjsonRun";
import {
	isTerminalStreamEvent,
	periodDigestStreamEventSchema,
} from "#/lib/client-stream-contracts";
import { injectTopicHeadings } from "#/lib/period-digest-markdown";
import type {
	PeriodDigestContext,
	PeriodDigestRunResult,
	PeriodDigestStreamEvent,
} from "#/lib/period-digest";
import type { ProfileRecord } from "#/lib/types";
import {
	exportCurrentPdf,
	exportReferenceCollectionPdf,
} from "#/lib/pdf-export-client";
import {
	hydrateProfileHandles,
	normalizeProfileHydrationHandle as normalizeHandle,
} from "#/lib/profile-hydration-client";
import {
	type PeriodRouteSearch,
	type RouteSearchChange,
	type TodayRouteSearch,
	validateTodaySearch,
} from "#/lib/route-search";
import { safeHttpUrl } from "#/lib/url-safety";
import {
	cx,
	errorCopyClass,
	pageHeaderActionsClass,
	pageHeaderClass,
	pageHeaderRowClass,
	pageSubtitleClass,
	pageTitleClass,
	secondaryButtonClass,
	segmentClass,
	segmentedClass,
} from "#/lib/ui";

export const Route = createFileRoute("/today")({
	component: TodayRoute,
	validateSearch: validateTodaySearch,
});

type PeriodOption = PeriodRouteSearch;
type ReferenceTweet = PeriodDigestContext["tweets"][number];
type ReferenceDm = PeriodDigestContext["dms"][number];
type ReferenceFeedItem = NonNullable<PeriodDigestContext["feedItems"]>[number];
type ReferenceSource =
	| { kind: "tweet"; id: string }
	| { kind: "feed"; id: string };
type ReferenceGroup = {
	section: string;
	title: string;
	summary: string;
	tweetIds: string[];
	feedItemIds: string[];
};
const PROFILE_HYDRATION_LIMIT = 12;
const PROFILE_HYDRATION_DELAY_MS = 300;
const DIGEST_STATUS_MESSAGES = {
	524: "Digest startup timed out at Cloudflare (524). Retry to open a new stream.",
} as const;
const todayPeriodSegmentActiveClass =
	"!bg-[var(--accent)] !text-[var(--accent-text)] shadow-[0_0_0_1px_color-mix(in_srgb,var(--accent)_35%,transparent)]";
const todayMarkdownLinkClass =
	"text-[var(--ink)] underline-offset-2 hover:underline";

const periods: Array<{ value: PeriodOption; label: string }> = [
	{ value: "today", label: "Today" },
	{ value: "24h", label: "24h" },
	{ value: "yesterday", label: "Yesterday" },
	{ value: "week", label: "Week" },
	{ value: "custom", label: "Custom" },
];

const referenceSectionLabels: Record<string, string> = {
	"Opening summary": "开篇摘要",
	"At a glance": "一览",
	"Key events and themes": "重点事件与主题",
	"Worth reading": "值得细读",
	"Watch next": "后续观察",
	"What happened": "重点事件",
	"What people are talking about": "热议主题",
	"Important links shared": "重要链接",
	"Action items": "行动线索",
	"Worth opening": "值得细读",
	"Supplemental source list": "补充来源",
};

const referenceSectionNotes: Record<string, string> = {
	"Opening summary": "先读总述，再按编号追原文。",
	"At a glance": "先掌握最重要的变化与影响。",
	"Key events and themes": "按事件融合快讯、文章与推文证据。",
	"Worth reading": "集中阅读最值得打开的文章与推文。",
	"Watch next": "核对后续可验证的观察点。",
	"What happened": "按事件融合快讯、文章与推文证据。",
	"What people are talking about": "按市场和产业主题逐组阅读。",
	"Important links shared": "集中核对文章和外部材料的来源。",
	"Action items": "按待处理事项回看对应原文。",
	"Worth opening": "长文和图表较多，适合打印精读。",
	"Supplemental source list": "只作完整性补充。",
};

const referenceSectionAliases: Record<string, string> = {
	一览: "At a glance",
	一眼看懂: "At a glance",
	重点事件与主题: "Key events and themes",
	关键事件与主题: "Key events and themes",
	值得阅读: "Worth reading",
	后续观察: "Watch next",
	接下来关注: "Watch next",
	发生了什么: "What happened",
	重点事件: "What happened",
	今日重点: "What happened",
	大家在聊什么: "What people are talking about",
	热议主题: "What people are talking about",
	重要链接: "Important links shared",
	重要链接分享: "Important links shared",
	行动线索: "Action items",
	行动项: "Action items",
	值得打开: "Worth opening",
	值得细读: "Worth opening",
	补充来源: "Supplemental source list",
};

function periodLabel(period: PeriodOption) {
	return periods.find((item) => item.value === period)?.label ?? "Digest";
}

function digestUrl(
	period: PeriodOption,
	includeDms: boolean,
	includeFeed: boolean,
	refresh: boolean,
	since: string,
	until: string,
) {
	const url = new URL("/api/period-digest", window.location.origin);
	url.searchParams.set("period", period);
	url.searchParams.set("includeDms", String(includeDms));
	url.searchParams.set("includeFeed", String(includeFeed));
	url.searchParams.set("maxTweets", "5000");
	url.searchParams.set("maxLinks", "20");
	// Cloudflare caps proxied requests; live timeline sync remains a separate job/UI action.
	url.searchParams.set("liveSync", "false");
	if (period === "custom" && since && until) {
		url.searchParams.set("since", since);
		url.searchParams.set("until", until);
	}
	if (refresh) {
		url.searchParams.set("refresh", "true");
	}
	return url;
}

function digestStreamError(cause: unknown, phase: string) {
	const message = cause instanceof Error ? cause.message : String(cause);
	if (/OpenAI request failed: (?:408|409|429|5\d\d)\b/i.test(message)) {
		return /\(after \d+ attempts\)$/i.test(message)
			? "AI service is temporarily unavailable. BirdClaw retried automatically; retry again in a moment."
			: "AI service is temporarily unavailable. Retry again in a moment.";
	}
	if (
		cause instanceof TypeError &&
		/network error|failed to fetch|load failed/i.test(message)
	) {
		return `Digest connection was interrupted while ${phase.toLowerCase()}. Retry to continue.`;
	}
	if (cause instanceof SyntaxError) {
		return `Digest stream returned invalid data while ${phase.toLowerCase()}. Retry to continue.`;
	}
	return message || "Digest failed";
}

function formatCounts(context: PeriodDigestContext | null) {
	if (!context)
		return "Local Twitter memory. Generate a summary only when needed.";
	const counts = context.counts;
	const feedItems = context.feedItems ?? [];
	const flashCount = feedItems.filter((item) => item.kind === "flash").length;
	const articleCount = feedItems.filter(
		(item) => item.kind === "article",
	).length;
	return [
		`${String(counts.home)} home`,
		context.twitterScope === "home"
			? null
			: `${String(counts.mentions)} mentions`,
		context.includeFeed ? `${String(flashCount)} flashes` : null,
		context.includeFeed ? `${String(articleCount)} articles` : null,
		`${String(counts.links)} links`,
		context.includeDms ? `${String(counts.dms)} DMs` : null,
	]
		.filter(Boolean)
		.join(" · ");
}

function markdownReferencePlainText(value: string) {
	return value
		.replaceAll(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1")
		.replaceAll(/\*\*([^*]+)\*\*/g, "$1")
		.replaceAll(/\s+/g, " ")
		.trim();
}

function normalizeReferenceTitle(value: string) {
	return markdownReferencePlainText(value).toLocaleLowerCase();
}

function markdownReferenceSectionHeading(line: string) {
	const markdownHeading = /^##(?!#)\s+(.+?)\s*#*\s*$/.exec(line);
	if (markdownHeading?.[1]) {
		const title = markdownReferencePlainText(markdownHeading[1]);
		return referenceSectionAliases[title] ?? title;
	}
	const boldHeading = /^\*\*([^*]+)\*\*$/.exec(line);
	const boldTitle = boldHeading?.[1]
		? markdownReferencePlainText(boldHeading[1])
		: "";
	if (!boldTitle) return null;
	const alias = referenceSectionAliases[boldTitle];
	if (alias) return alias;
	return referenceSectionLabels[boldTitle] ? boldTitle : null;
}

function markdownReferenceDocumentMeta(
	markdown: string,
	fallbackTitle: string,
	fallbackSummary: string,
) {
	let title = "";
	const summary: string[] = [];
	for (const rawLine of markdown.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		const titleHeading = /^#(?!#)\s+(.+?)\s*#*\s*$/.exec(line);
		if (titleHeading?.[1] && !title) {
			title = markdownReferencePlainText(titleHeading[1]);
			continue;
		}
		if (
			markdownReferenceSectionHeading(line) ||
			/^#{2,6}\s+/.test(line) ||
			/^\s*[-*+]\s+/.test(rawLine)
		) {
			break;
		}
		summary.push(line);
	}
	return {
		title: title || fallbackTitle,
		summary:
			markdownReferencePlainText(stripMarkdownCitations(summary.join(" "))) ||
			fallbackSummary,
	};
}

function normalizeReferenceTweetId(value: string) {
	const trimmed = value.trim().replace(/^[\s(]+|[\s)]+$/g, "");
	return /^tweet_\d{12,25}$/.test(trimmed)
		? trimmed.slice("tweet_".length)
		: trimmed;
}

function extractReferenceIds(value: string) {
	const ids: string[] = [];
	for (const token of value.matchAll(/tweet_[A-Za-z0-9_-]+|\d{12,25}/g)) {
		const normalized = normalizeReferenceTweetId(token[0]);
		if (!ids.includes(normalized)) ids.push(normalized);
	}
	return ids;
}

function extractMarkdownCitationIds(value: string) {
	const ids: string[] = [];
	for (const match of value.matchAll(/[（(]([^()（）]+)[）)]/g)) {
		const block = match[1] ?? "";
		const remainder = block
			.replaceAll(/tweet_[A-Za-z0-9_-]+|\d{12,25}/g, "")
			.replaceAll(/[\s,，、]/g, "");
		if (remainder) continue;
		for (const id of extractReferenceIds(block)) {
			if (!ids.includes(id)) ids.push(id);
		}
	}
	return ids;
}

function stripMarkdownCitations(value: string) {
	return value
		.replaceAll(
			/\s*[（(](?:\s*(?:tweet_[A-Za-z0-9_-]+|\d{12,25})\s*[,，、]?)+[）)]\s*/g,
			" ",
		)
		.replaceAll(/\s+/g, " ")
		.trim();
}

function referenceTweetLookupKeys(value: string) {
	const normalized = normalizeReferenceTweetId(value);
	const withoutPrefix = value.trim().replace(/^tweet_/, "");
	return [
		...new Set([
			value.trim(),
			normalized,
			withoutPrefix,
			`tweet_${normalized}`,
		]),
	];
}

function buildReferenceTweetLookup(context: PeriodDigestContext) {
	const lookup = new Map<string, ReferenceTweet>();
	for (const tweet of context.tweets) {
		for (const key of referenceTweetLookupKeys(tweet.id)) {
			lookup.set(key, tweet);
		}
	}
	return lookup;
}

function buildReferenceFeedLookup(context: PeriodDigestContext) {
	return new Map((context.feedItems ?? []).map((item) => [item.id, item]));
}

function exactMarkdownFeedItemIds(
	markdown: string,
	feedItems: readonly ReferenceFeedItem[],
) {
	const itemsByUrl = new Map<string, ReferenceFeedItem[]>();
	for (const item of feedItems) {
		const url = safeHttpUrl(item.url);
		if (!url) continue;
		const matches = itemsByUrl.get(url) ?? [];
		matches.push(item);
		itemsByUrl.set(url, matches);
	}
	const ids: string[] = [];
	for (const match of markdown.matchAll(
		/\[[^\]\n]+\]\((https?:\/\/[^\s)]+)\)/g,
	)) {
		const url = match[1] ? safeHttpUrl(match[1]) : null;
		if (!url) continue;
		const matches = itemsByUrl.get(url) ?? [];
		if (matches.length !== 1 || ids.includes(matches[0]!.id)) continue;
		ids.push(matches[0]!.id);
	}
	return ids;
}

function referenceSourceKey(source: ReferenceSource) {
	return source.kind === "tweet"
		? `tweet:${normalizeReferenceTweetId(source.id)}`
		: `feed:${source.id.trim()}`;
}

function referenceSourcesForGroup(group: ReferenceGroup): ReferenceSource[] {
	const sources: ReferenceSource[] = [
		...group.feedItemIds.map((id) => ({ kind: "feed" as const, id })),
		...group.tweetIds.map((id) => ({ kind: "tweet" as const, id })),
	];
	const seen = new Set<string>();
	return sources.filter((source) => {
		const key = referenceSourceKey(source);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function collectStructuredReferenceGroups(result: PeriodDigestRunResult) {
	const groups: ReferenceGroup[] = [];
	for (const topic of result.digest.keyTopics) {
		const feedItemIds = topic.feedItemIds ?? [];
		if (topic.tweetIds.length === 0 && feedItemIds.length === 0) continue;
		groups.push({
			section: "What happened",
			title: topic.title,
			summary: topic.summary,
			tweetIds: topic.tweetIds,
			feedItemIds,
		});
	}
	for (const link of result.digest.notableLinks) {
		const feedItemIds = link.sourceFeedItemIds ?? [];
		if (link.sourceTweetIds.length === 0 && feedItemIds.length === 0) continue;
		groups.push({
			section: "Important links shared",
			title: link.title,
			summary: link.why,
			tweetIds: link.sourceTweetIds,
			feedItemIds,
		});
	}
	for (const action of result.digest.actionItems) {
		if (!action.tweetId) continue;
		groups.push({
			section: "Action items",
			title: action.label,
			summary: action.kind.replace("_", " "),
			tweetIds: [action.tweetId],
			feedItemIds: [],
		});
	}

	const seen = new Set(
		groups.flatMap((group) => group.tweetIds.map(normalizeReferenceTweetId)),
	);
	const supplemental = result.digest.sourceTweetIds.filter(
		(tweetId) => !seen.has(normalizeReferenceTweetId(tweetId)),
	);
	if (supplemental.length > 0) {
		groups.push({
			section: "Supplemental source list",
			title: "未在正文主题里直接成组的来源",
			summary: "这些来源来自当前 digest 的引用集合，单独列出便于补查。",
			tweetIds: supplemental,
			feedItemIds: [],
		});
	}
	return groups;
}

function collectMarkdownReferenceGroups(
	markdown: string,
	sourceTweetIds: string[],
	feedItems: readonly ReferenceFeedItem[],
) {
	const groups: ReferenceGroup[] = [];
	const lines = markdown.split(/\r?\n/);
	let section = "Opening summary";
	let topicTitle = "";
	for (let index = 0; index < lines.length; index += 1) {
		const rawLine = lines[index] ?? "";
		const line = rawLine.trim();
		if (!line) continue;
		const sectionHeading = markdownReferenceSectionHeading(line);
		if (sectionHeading) {
			section = sectionHeading;
			topicTitle = "";
			continue;
		}
		if (/^#{3,6}\s+/.test(line)) {
			topicTitle = markdownReferencePlainText(
				line.replace(/^#{3,6}\s+/, "").replace(/\s+#+$/, ""),
			);
			continue;
		}
		const bulletMatch = /^\s*[-*+]\s+(.+)$/.exec(rawLine);
		if (!bulletMatch?.[1]) continue;

		const bulletLines = [bulletMatch[1].trim()];
		let cursor = index + 1;
		for (; cursor < lines.length; cursor += 1) {
			const continuationRaw = lines[cursor] ?? "";
			const continuation = continuationRaw.trim();
			if (
				/^\s*[-*+]\s+/.test(continuationRaw) ||
				/^#{1,6}\s+/.test(continuation) ||
				markdownReferenceSectionHeading(continuation)
			) {
				break;
			}
			if (continuation) bulletLines.push(continuation);
		}
		index = cursor - 1;
		const bullet = bulletLines.join(" ");
		const tweetIds = extractMarkdownCitationIds(bullet);
		const feedItemIds = exactMarkdownFeedItemIds(bullet, feedItems);

		const bold = bullet.match(/^\*\*([^*]+)\*\*\s*(.*)$/);
		const link = bullet.match(/^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/);
		let title = markdownReferencePlainText(stripMarkdownCitations(bullet));
		let summary = title;
		if (topicTitle) {
			title = topicTitle;
			summary = markdownReferencePlainText(stripMarkdownCitations(bullet));
		} else if (bold) {
			title = markdownReferencePlainText(bold[1] ?? "").replace(
				/[。.:：]+$/g,
				"",
			);
			summary = markdownReferencePlainText(
				stripMarkdownCitations(bold[2] ?? ""),
			).replace(/^[。.:：\s]+/g, "");
		} else if (link) {
			title = markdownReferencePlainText(link[1] ?? "").replace(
				/[。.:：]+$/g,
				"",
			);
			summary = markdownReferencePlainText(stripMarkdownCitations(bullet));
		} else {
			const conciseTitle = /^(.{2,80}?)[：:]\s*(.+)$/.exec(
				markdownReferencePlainText(stripMarkdownCitations(bullet)),
			);
			if (conciseTitle?.[1]) {
				title = conciseTitle[1].replace(/[。.:：]+$/g, "");
			}
		}
		const previous = groups.at(-1);
		if (
			topicTitle &&
			previous?.section === section &&
			previous.title === title
		) {
			previous.summary = `${previous.summary}\n\n${summary}`;
			for (const tweetId of tweetIds) {
				if (!previous.tweetIds.includes(tweetId)) {
					previous.tweetIds.push(tweetId);
				}
			}
			for (const feedItemId of feedItemIds) {
				if (!previous.feedItemIds.includes(feedItemId)) {
					previous.feedItemIds.push(feedItemId);
				}
			}
		} else {
			groups.push({
				section,
				title,
				summary,
				tweetIds,
				feedItemIds,
			});
		}
	}

	const seen = new Set(
		groups.flatMap((group) => group.tweetIds.map(normalizeReferenceTweetId)),
	);
	const supplemental = sourceTweetIds
		.map(normalizeReferenceTweetId)
		.filter((tweetId) => !seen.has(tweetId));
	if (supplemental.length > 0) {
		groups.push({
			section: "Supplemental source list",
			title: "未在正文主题里直接成组的来源",
			summary: "这些来源来自当前 digest 的引用集合，单独列出便于补查。",
			tweetIds: supplemental,
			feedItemIds: [],
		});
	}
	return groups;
}

function collectReferenceGroups(
	result: PeriodDigestRunResult,
	markdown: string,
) {
	const markdownGroups = collectMarkdownReferenceGroups(
		markdown,
		result.digest.sourceTweetIds,
		result.context.feedItems ?? [],
	);
	if (markdownGroups.length === 0)
		return collectStructuredReferenceGroups(result);

	const matchedTopicTitles = new Set<string>();
	const matchedLinkTitles = new Set<string>();
	for (const group of markdownGroups) {
		const groupTitle = normalizeReferenceTitle(group.title);
		const topic = result.digest.keyTopics.find(
			(candidate) => normalizeReferenceTitle(candidate.title) === groupTitle,
		);
		if (topic) {
			group.feedItemIds = [
				...new Set([...group.feedItemIds, ...(topic.feedItemIds ?? [])]),
			];
			matchedTopicTitles.add(normalizeReferenceTitle(topic.title));
			continue;
		}
		const link = result.digest.notableLinks.find(
			(candidate) => normalizeReferenceTitle(candidate.title) === groupTitle,
		);
		if (link) {
			group.feedItemIds = [
				...new Set([...group.feedItemIds, ...(link.sourceFeedItemIds ?? [])]),
			];
			matchedLinkTitles.add(normalizeReferenceTitle(link.title));
		}
	}

	for (const topic of result.digest.keyTopics) {
		const title = normalizeReferenceTitle(topic.title);
		const feedItemIds = topic.feedItemIds ?? [];
		if (matchedTopicTitles.has(title) || feedItemIds.length === 0) continue;
		markdownGroups.push({
			section: "What happened",
			title: topic.title,
			summary: topic.summary,
			tweetIds: topic.tweetIds,
			feedItemIds,
		});
	}
	for (const link of result.digest.notableLinks) {
		const title = normalizeReferenceTitle(link.title);
		const feedItemIds = link.sourceFeedItemIds ?? [];
		if (matchedLinkTitles.has(title) || feedItemIds.length === 0) continue;
		markdownGroups.push({
			section: "Important links shared",
			title: link.title,
			summary: link.why,
			tweetIds: link.sourceTweetIds,
			feedItemIds,
		});
	}
	return markdownGroups;
}

function collectReferenceLabels(groups: ReferenceGroup[]) {
	const orderedSources: ReferenceSource[] = [];
	const labelsByKey = new Map<string, string>();
	for (const group of groups) {
		for (const source of referenceSourcesForGroup(group)) {
			const key = referenceSourceKey(source);
			if (labelsByKey.has(key)) continue;
			orderedSources.push(source);
			labelsByKey.set(
				key,
				`S${String(orderedSources.length).padStart(2, "0")}`,
			);
		}
	}
	return { orderedSources, labelsByKey };
}

function groupReferenceSections(groups: ReferenceGroup[]) {
	const sections: Array<{
		key: string;
		title: string;
		groups: ReferenceGroup[];
	}> = [];
	for (const group of groups) {
		const title = referenceSectionLabels[group.section] ?? group.section;
		const section = sections.find(
			(candidate) => candidate.key === group.section,
		);
		if (section) {
			section.groups.push(group);
		} else {
			sections.push({ key: group.section, title, groups: [group] });
		}
	}
	return sections;
}

function referenceTweetFor(
	lookup: Map<string, ReferenceTweet>,
	tweetId: string,
) {
	for (const key of referenceTweetLookupKeys(tweetId)) {
		const tweet = lookup.get(key);
		if (tweet) return tweet;
	}
	return null;
}

function formatReferenceAuthor(tweet: ReferenceTweet) {
	const handle = tweet.author.startsWith("@")
		? tweet.author
		: `@${tweet.author}`;
	const normalizedName = tweet.name?.trim().replace(/^@/, "");
	const normalizedAuthor = tweet.author.trim().replace(/^@/, "");
	return tweet.name && normalizedName !== normalizedAuthor
		? `${tweet.name} (${handle})`
		: handle;
}

function formatReferenceDate(value: string) {
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) return "";
	return parsed.toLocaleDateString("sv-SE");
}

function formatReferenceTimestamp(value: string) {
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) return "";
	return `${parsed.toLocaleDateString("sv-SE")} ${parsed.toLocaleTimeString(
		"sv-SE",
		{
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		},
	)}`;
}

function ReferenceTweetCard({
	anchorId,
	includeMedia,
	label,
	tweet,
}: {
	anchorId?: string;
	includeMedia: boolean;
	label: string;
	tweet: ReferenceTweet | null;
}) {
	if (!tweet) {
		return (
			<section className="today-reference-source">
				<div className="today-reference-source-head" id={anchorId}>
					<span className="today-reference-badge">{label}</span>
					<strong className="today-reference-author">缺失原文</strong>
				</div>
				<p className="today-reference-source-body">
					当前缓存结果里没有这条来源的正文。
				</p>
			</section>
		);
	}
	return (
		<section className="today-reference-source">
			<div className="today-reference-source-head" id={anchorId}>
				<span className="today-reference-badge">{label}</span>
				<strong className="today-reference-author">
					<span>{formatReferenceAuthor(tweet)}</span>
				</strong>
				{tweet.createdAt ? (
					<time dateTime={tweet.createdAt}>
						{formatReferenceTimestamp(tweet.createdAt)}
					</time>
				) : null}
			</div>
			<p className="today-reference-source-body">
				{tweet.text || "(empty text)"}
			</p>
			<ReferencePrintMedia items={includeMedia ? tweet.media : []} />
			{tweet.replyToTweet ? (
				<blockquote>
					<strong>
						回复上下文：@
						{tweet.replyToTweet.author}
						{tweet.replyToTweet.createdAt
							? ` · ${formatReferenceTimestamp(tweet.replyToTweet.createdAt)}`
							: ""}
					</strong>
					<span>{tweet.replyToTweet.text}</span>
				</blockquote>
			) : null}
		</section>
	);
}

function ReferenceDmCard({ item }: { item: ReferenceDm }) {
	return (
		<section className="today-reference-source">
			<div className="today-reference-source-head">
				<span className="today-reference-badge">DM</span>
				<strong className="today-reference-author">
					{item.name || item.participant}
				</strong>
			</div>
			<p className="today-reference-source-body">
				{item.text || "(empty message)"}
			</p>
		</section>
	);
}

function ReferenceFeedCard({
	anchorId,
	item,
	label,
}: {
	anchorId?: string;
	item: ReferenceFeedItem | null;
	label: string;
}) {
	if (!item) {
		return (
			<section className="today-reference-source">
				<div className="today-reference-source-head" id={anchorId}>
					<span className="today-reference-badge">{label}</span>
					<strong className="today-reference-author">缺失编辑来源</strong>
				</div>
				<p className="today-reference-source-body">
					当前缓存结果里没有这条快讯或文章的正文。
				</p>
			</section>
		);
	}
	const href = safeHttpUrl(item.url);
	return (
		<section className="today-reference-source">
			<div className="today-reference-source-head" id={anchorId}>
				<span className="today-reference-badge">{label}</span>
				<strong className="today-reference-author">
					<span>{item.kind === "flash" ? "快讯" : "文章"}</span>
					<span>{item.publisher}</span>
				</strong>
				<time dateTime={item.publishedAt}>
					{formatReferenceTimestamp(item.publishedAt)}
				</time>
			</div>
			<p className="today-reference-source-body">
				<strong>{item.title}</strong>
				{item.summary ? `\n\n${item.summary}` : ""}
			</p>
			{href ? (
				<p>
					<a href={href} rel="noreferrer">
						查看发布方原文
					</a>
				</p>
			) : null}
		</section>
	);
}

function TodayTopicSources({
	group,
	result,
}: {
	group: ReferenceGroup;
	result: PeriodDigestRunResult;
}) {
	const tweetLookup = buildReferenceTweetLookup(result.context);
	const feedLookup = buildReferenceFeedLookup(result.context);
	const sources = referenceSourcesForGroup(group);
	if (sources.length === 0) return null;
	return (
		<section
			aria-label={`${group.title} sources`}
			className="today-screen-only my-2 rounded-xl border border-[var(--line)] bg-[var(--bg-hover)] p-2.5"
			data-testid="today-topic-sources"
		>
			<p className="mb-2 text-[11px] font-bold tracking-[0.12em] text-[var(--ink-soft)] uppercase">
				本主题来源
			</p>
			<div className="flex flex-col gap-1.5">
				{sources.map((source) => {
					const key = referenceSourceKey(source);
					if (source.kind === "feed") {
						const item = feedLookup.get(source.id) ?? null;
						const label = item?.kind === "article" ? "文章" : "快讯";
						const href = item ? safeHttpUrl(item.url) : null;
						return (
							<details
								className="group rounded-lg border border-[var(--line)] bg-[var(--bg)] px-2.5 py-2"
								key={key}
							>
								<summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
									<span className="shrink-0 rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[11px] font-bold text-[var(--accent)]">
										{label}
									</span>
									<span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-[var(--ink)]">
										{item?.publisher || "编辑来源暂不可用"}
									</span>
									<span className="text-[11px] text-[var(--ink-soft)] group-open:hidden">
										查看
									</span>
									<span className="hidden text-[11px] text-[var(--ink-soft)] group-open:inline">
										收起
									</span>
								</summary>
								<div className="mt-2 border-t border-[var(--line)] pt-2 text-[12px] leading-5 text-[var(--ink-soft)]">
									<p className="whitespace-pre-wrap">
										{item
											? `${item.title}${item.summary ? `\n${item.summary}` : ""}`
											: "当前缓存结果里没有这条编辑来源的正文。"}
									</p>
									{href ? (
										<a
											aria-label={`打开${label}原文：${item?.title ?? source.id}`}
											className="mt-1.5 inline-flex font-semibold text-[var(--ink)] underline underline-offset-2"
											href={href}
											rel="noreferrer"
											target="_blank"
										>
											打开发布方原文
										</a>
									) : null}
								</div>
							</details>
						);
					}

					const tweet = referenceTweetFor(tweetLookup, source.id);
					const label = tweet?.specialFollow ? "特别关注" : "推文";
					const href = tweet ? safeHttpUrl(tweet.url) : null;
					return (
						<details
							className="group rounded-lg border border-[var(--line)] bg-[var(--bg)] px-2.5 py-2"
							key={key}
						>
							<summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
								<span className="shrink-0 rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[11px] font-bold text-[var(--accent)]">
									{label}
								</span>
								<span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-[var(--ink)]">
									{tweet ? formatReferenceAuthor(tweet) : "推文原文暂不可用"}
								</span>
								<span className="text-[11px] text-[var(--ink-soft)] group-open:hidden">
									查看
								</span>
								<span className="hidden text-[11px] text-[var(--ink-soft)] group-open:inline">
									收起
								</span>
							</summary>
							<div className="mt-2 border-t border-[var(--line)] pt-2 text-[12px] leading-5 text-[var(--ink-soft)]">
								<p className="whitespace-pre-wrap">
									{tweet?.text || "当前缓存结果里没有这条推文的正文。"}
								</p>
								{href ? (
									<a
										aria-label={`打开${label}原文：${tweet?.author ?? source.id}`}
										className="mt-1.5 inline-flex font-semibold text-[var(--ink)] underline underline-offset-2"
										href={href}
										rel="noreferrer"
										target="_blank"
									>
										打开 X 原文
									</a>
								) : null}
							</div>
						</details>
					);
				})}
			</div>
		</section>
	);
}

function ReferenceDigestPrint({
	generatedAt,
	markdown,
	result,
}: {
	generatedAt: string | null;
	markdown: string;
	result: PeriodDigestRunResult;
}) {
	const groups = collectReferenceGroups(result, markdown);
	const documentMeta = markdownReferenceDocumentMeta(
		markdown,
		result.digest.title || `${result.context.window.label} digest`,
		result.digest.summary,
	);
	const sections = groupReferenceSections(groups);
	const tweetLookup = buildReferenceTweetLookup(result.context);
	const feedLookup = buildReferenceFeedLookup(result.context);
	const { labelsByKey, orderedSources } = collectReferenceLabels(groups);
	const sourceCount = orderedSources.length;
	const sourceScopeLabel = result.context.includeFeed ? "Home + Feed" : "Home";
	const groupAnchors = new Map(
		groups.map((group, index) => [
			group,
			`reference-topic-${String(index + 1)}`,
		]),
	);
	const groupIndexes = new Map(groups.map((group, index) => [group, index]));
	const firstGroupBySource = new Map<string, number>();
	for (const [groupIndex, group] of groups.entries()) {
		for (const source of referenceSourcesForGroup(group)) {
			const key = referenceSourceKey(source);
			if (!firstGroupBySource.has(key)) {
				firstGroupBySource.set(key, groupIndex);
			}
		}
	}
	const sourceLabelsFor = (group: ReferenceGroup) =>
		referenceSourcesForGroup(group)
			.map((source) => labelsByKey.get(referenceSourceKey(source)))
			.filter((label): label is string => Boolean(label));
	const windowSince = formatReferenceDate(result.context.window.since);
	const windowUntil = formatReferenceDate(result.context.window.until);
	const coverTitle = `BirdClaw ${result.context.window.label} 参考内容合集`;
	return (
		<article
			aria-label="参考内容合集"
			className="today-reference-pdf"
			data-testid="today-reference-pdf"
		>
			<header className="today-reference-cover today-reference-sheet">
				<h1>{coverTitle}</h1>
				<p className="today-reference-cover-subtitle">{documentMeta.title}</p>
				<p className="today-reference-cover-summary">{documentMeta.summary}</p>
				<p className="today-reference-cover-meta">
					窗口：{result.context.window.label}
					{windowSince && windowUntil
						? ` · ${windowSince} 至 ${windowUntil}`
						: ""}
					<br />
					{generatedAt ? `生成日期：${generatedAt} · ` : ""}
					来源：{String(sourceCount)} 条引用原文（{sourceScopeLabel}）
				</p>
				<table className="today-reference-cover-table">
					<tbody>
						<tr>
							<th>排版目标</th>
							<td>
								适合打印、逐条阅读和做边注；快讯、文章与推文按主题共同编排，推文图片使用紧凑网格保留。
							</td>
						</tr>
						<tr>
							<th>组织方式</th>
							<td>
								按网页总结中的主题分组，每组摘要后接对应原文；全册使用统一的 S
								编号。
							</td>
						</tr>
						<tr>
							<th>作者信息</th>
							<td>
								每条原文标明来源类型、发布方或作者与精确时间；媒体报道和社交观点保持清楚边界。
							</td>
						</tr>
					</tbody>
				</table>
				<h2>本册导航</h2>
				<table className="today-reference-navigation-table">
					<thead>
						<tr>
							<th>内容块</th>
							<th>主题</th>
							<th>原文</th>
							<th>读法</th>
						</tr>
					</thead>
					<tbody>
						{sections.map((section) => (
							<tr key={section.key}>
								<th>{section.title}</th>
								<td>{String(section.groups.length)} 个</td>
								<td>
									{String(
										new Set(section.groups.flatMap(sourceLabelsFor)).size,
									)}{" "}
									条
								</td>
								<td>{referenceSectionNotes[section.key] ?? "按主题阅读。"}</td>
							</tr>
						))}
					</tbody>
				</table>
				<h2 className="today-reference-cover-topics-title">重点主题</h2>
				<ol className="today-reference-cover-topics">
					{groups.slice(0, 6).map((group) => (
						<li key={`cover-${groupAnchors.get(group) ?? group.title}`}>
							{group.title}
						</li>
					))}
				</ol>
			</header>

			<section className="today-reference-guide today-reference-sheet">
				<h2>阅读说明</h2>
				<p>
					{result.context.includeFeed
						? "这份合集不是网页截图，而是把总结实际引用的快讯、文章与 Home 推文按同一主题重新编排。每个主题先给出总结，再紧接支撑它的编辑来源与社交观点。"
						: "这份合集不是网页截图，而是把总结引用的 Home 推文按主题重新编排。每个主题先保留网页上的标题和摘要，随后列出对应原文。"}
					S01、S02 等是全册统一来源编号，类型标签用于区分快讯、文章和推文。
				</p>
				<h2>目录</h2>
				{groups.length > 0 ? (
					<div className="today-reference-toc">
						{sections.map((section) => (
							<section key={section.key}>
								<h3>{section.title}</h3>
								<ol>
									{section.groups.map((group) => (
										<li key={groupAnchors.get(group)}>
											<a href={`#${groupAnchors.get(group) ?? ""}`}>
												<span>{group.title}</span>
												<small
													data-reference-page-target={groupAnchors.get(group)}
												>
													…
												</small>
											</a>
										</li>
									))}
								</ol>
							</section>
						))}
					</div>
				) : (
					<p>当前 digest 没有可映射的引用来源。</p>
				)}
			</section>

			<section className="today-reference-matrix today-reference-sheet">
				<h2>来源矩阵</h2>
				<p>
					先看这一页可以知道每个主题涉及哪些原文。文末还有按 S
					编号排序的来源索引。
				</p>
				<table>
					<thead>
						<tr>
							<th>分类</th>
							<th>主题</th>
							<th>来源编号</th>
						</tr>
					</thead>
					<tbody>
						{groups.map((group) => (
							<tr key={`matrix-${groupAnchors.get(group) ?? group.title}`}>
								<td>
									{referenceSectionLabels[group.section] ?? group.section}
								</td>
								<td>{group.title}</td>
								<td>{sourceLabelsFor(group).join(", ")}</td>
							</tr>
						))}
					</tbody>
				</table>
			</section>

			{sections.map((section) => (
				<section className="today-reference-section" key={section.key}>
					<h2>{section.title}</h2>
					{section.groups.map((group) => (
						<section
							className="today-reference-group"
							key={groupAnchors.get(group)}
						>
							<h3 id={groupAnchors.get(group)}>{group.title}</h3>
							<p>{group.summary}</p>
							<p className="today-reference-source-list">
								本主题原文：{sourceLabelsFor(group).join(", ")} · 共{" "}
								{String(sourceLabelsFor(group).length)} 条
							</p>
							{group.feedItemIds.map((feedItemId) => {
								const source = { kind: "feed" as const, id: feedItemId };
								const key = referenceSourceKey(source);
								const item = feedLookup.get(feedItemId) ?? null;
								const label = labelsByKey.get(key) ?? feedItemId;
								const firstOccurrence =
									firstGroupBySource.get(key) === groupIndexes.get(group);
								if (!firstOccurrence) return null;
								return (
									<ReferenceFeedCard
										anchorId={
											firstOccurrence ? `reference-source-${label}` : undefined
										}
										item={item}
										key={key}
										label={label}
									/>
								);
							})}
							{group.tweetIds.map((tweetId) => {
								const normalized = normalizeReferenceTweetId(tweetId);
								const source = { kind: "tweet" as const, id: normalized };
								const key = referenceSourceKey(source);
								const label = labelsByKey.get(key) ?? normalized;
								const firstOccurrence =
									firstGroupBySource.get(key) === groupIndexes.get(group);
								if (!firstOccurrence) return null;
								return (
									<ReferenceTweetCard
										anchorId={
											firstOccurrence ? `reference-source-${label}` : undefined
										}
										includeMedia={firstOccurrence}
										key={key}
										label={label}
										tweet={referenceTweetFor(tweetLookup, tweetId)}
									/>
								);
							})}
						</section>
					))}
				</section>
			))}

			{result.context.includeDms && result.context.dms.length > 0 ? (
				<section className="today-reference-section">
					<h2>DM 摘录</h2>
					{result.context.dms.slice(0, 8).map((item) => (
						<ReferenceDmCard item={item} key={item.id} />
					))}
				</section>
			) : null}

			{orderedSources.length > 0 ? (
				<section className="today-reference-index today-reference-sheet">
					<h2>来源索引</h2>
					<p>
						这里按全局编号统一列出快讯、文章和推文，便于从纸面快速反查来源与所在页。
					</p>
					<table>
						<thead>
							<tr>
								<th>编号</th>
								<th>类型 / 来源</th>
								<th>标题或 ID</th>
								<th>发布时间</th>
								<th>页码</th>
							</tr>
						</thead>
						<tbody>
							{orderedSources.map((source) => {
								const key = referenceSourceKey(source);
								const label = labelsByKey.get(key) ?? source.id;
								const tweet =
									source.kind === "tweet"
										? referenceTweetFor(tweetLookup, source.id)
										: null;
								const feed =
									source.kind === "feed" ? feedLookup.get(source.id) : null;
								return (
									<tr key={key}>
										<td>
											<a href={`#reference-source-${label}`}>{label}</a>
										</td>
										<td>
											{feed
												? `${feed.kind === "flash" ? "快讯" : "文章"} · ${feed.publisher}`
												: tweet
													? `推文 · ${formatReferenceAuthor(tweet)}`
													: "缺失原文"}
										</td>
										<td>{feed?.title ?? tweet?.id ?? source.id}</td>
										<td>
											{formatReferenceTimestamp(
												feed?.publishedAt ?? tweet?.createdAt ?? "",
											)}
										</td>
										<td>
											<a
												aria-label={`${label} 所在页`}
												className="today-reference-index-page"
												data-reference-page-target={`reference-source-${label}`}
												href={`#reference-source-${label}`}
											>
												…
											</a>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</section>
			) : null}
		</article>
	);
}

function collectProfilesForHydration(result: PeriodDigestRunResult) {
	const handles = new Set<string>();
	const tweetIds = new Set<string>();
	for (const id of result.digest.sourceTweetIds) tweetIds.add(id);
	for (const topic of result.digest.keyTopics) {
		for (const id of topic.tweetIds) tweetIds.add(id);
	}
	for (const link of result.digest.notableLinks) {
		for (const id of link.sourceTweetIds) tweetIds.add(id);
	}
	for (const item of result.digest.actionItems) {
		if (item.tweetId) tweetIds.add(item.tweetId);
	}

	const tweetsById = new Map(
		result.context.tweets.flatMap((tweet) => [
			[tweet.id, tweet],
			[`tweet_${tweet.id}`, tweet],
		]),
	);
	for (const id of tweetIds) {
		const tweet = tweetsById.get(id);
		if (!tweet) continue;
		const handle = normalizeHandle(tweet.author);
		if (handle) handles.add(handle);
	}

	for (const tweet of result.context.tweets) {
		const handle = normalizeHandle(tweet.author);
		if (handle) handles.add(handle);
	}
	return [...handles];
}

function applyHydratedProfilesToContext(
	context: PeriodDigestContext,
	profilesByHandle: Map<string, ProfileRecord>,
) {
	let changed = false;
	const tweets = context.tweets.map((tweet) => {
		const profile = profilesByHandle.get(normalizeHandle(tweet.author));
		if (!profile || profile === tweet.authorProfile) return tweet;
		changed = true;
		return {
			...tweet,
			author: profile.handle,
			name: profile.displayName,
			authorProfile: profile,
		};
	});
	return changed ? { ...context, tweets } : context;
}

function applyHydratedProfilesToResult(
	result: PeriodDigestRunResult,
	profiles: ProfileRecord[],
) {
	const profilesByHandle = new Map(
		profiles.map((profile) => [normalizeHandle(profile.handle), profile]),
	);
	if (profilesByHandle.size === 0) return result;
	const context = applyHydratedProfilesToContext(
		result.context,
		profilesByHandle,
	);
	return context === result.context ? result : { ...result, context };
}

function useDigestStream(
	period: PeriodOption,
	includeDms: boolean,
	includeFeed: boolean,
	since: string,
	until: string,
) {
	const queryClient = useQueryClient();
	const [markdown, setMarkdown] = useState("");
	const [context, setContext] = useState<PeriodDigestContext | null>(null);
	const [result, setResult] = useState<PeriodDigestRunResult | null>(null);
	const [status, setStatus] = useState("Ready to generate");
	const latestStatusRef = useRef("Ready to generate");

	const onStart = useCallback(() => {
		setMarkdown("");
		setContext(null);
		setResult(null);
		setStatus("Starting digest");
		latestStatusRef.current = "Starting digest";
	}, []);
	const request = useCallback(
		(signal: AbortSignal, refresh: boolean) =>
			fetch(digestUrl(period, includeDms, includeFeed, refresh, since, until), {
				cache: "no-store",
				signal,
			}),
		[includeDms, includeFeed, period, since, until],
	);
	const onEvent = useCallback((event: PeriodDigestStreamEvent) => {
		if (event.type === "status") {
			latestStatusRef.current = event.detail
				? `${event.label} · ${event.detail}`
				: event.label;
			setStatus(latestStatusRef.current);
		} else if (event.type === "start") setContext(event.context);
		else if (event.type === "delta") {
			latestStatusRef.current = "Streaming AI summary";
			setStatus(latestStatusRef.current);
			setMarkdown((current) => current + event.delta);
		} else if (event.type === "done") {
			setResult(event.result);
			setContext(event.result.context);
			setMarkdown(event.result.markdown);
			setStatus(event.result.cached ? "Loaded cached report" : "Ready");
		} else if (event.type === "error") {
			throw new Error(event.error);
		}
	}, []);
	const onError = useCallback(() => setStatus("Digest failed"), []);
	const prematureEofError = useCallback(
		() =>
			new Error(
				`Digest connection closed while ${latestStatusRef.current.toLowerCase()}. Retry to continue.`,
			),
		[],
	);
	const formatError = useCallback(
		(cause: unknown) => digestStreamError(cause, latestStatusRef.current),
		[],
	);
	const { cancel, error, loading, run, setError } = useNdjsonRun({
		schema: periodDigestStreamEventSchema,
		request,
		onStart,
		onEvent,
		onError,
		isTerminal: isTerminalStreamEvent,
		errorLabel: "Digest request failed",
		emptyBodyMessage: "Digest request failed: empty response body",
		prematureEofError,
		formatError,
		statusMessages: DIGEST_STATUS_MESSAGES,
	});

	useEffect(() => {
		if (!result) return;
		const handles = collectProfilesForHydration(result);
		if (handles.length === 0) return;

		let active = true;
		let idleId: number | null = null;
		const runHydration = () => {
			hydrateProfileHandles(queryClient, handles, {
				limit: PROFILE_HYDRATION_LIMIT,
			})
				.then((response) => {
					if (!active) return;
					const { profiles } = response;
					if (profiles.length === 0) return;
					setResult((current) =>
						current
							? applyHydratedProfilesToResult(current, profiles)
							: current,
					);
					const profilesByHandle = new Map(
						profiles.map((profile) => [
							normalizeHandle(profile.handle),
							profile,
						]),
					);
					setContext((current) =>
						current
							? applyHydratedProfilesToContext(current, profilesByHandle)
							: current,
					);
				})
				.catch((error: unknown) => {
					if (!active) return;
					console.warn("Profile hydration failed", error);
				});
		};
		const timer = window.setTimeout(() => {
			if ("requestIdleCallback" in window) {
				idleId = window.requestIdleCallback(runHydration, { timeout: 2500 });
			} else {
				runHydration();
			}
		}, PROFILE_HYDRATION_DELAY_MS);

		return () => {
			active = false;
			window.clearTimeout(timer);
			if (idleId !== null && "cancelIdleCallback" in window) {
				window.cancelIdleCallback(idleId);
			}
		};
	}, [queryClient, result]);

	const restore = useCallback(
		(savedResult: PeriodDigestRunResult) => {
			cancel();
			setError(null);
			setContext(savedResult.context);
			setMarkdown(savedResult.markdown);
			setResult(savedResult);
			setStatus("Restored from daily history · 0 token");
		},
		[cancel, setError],
	);
	const clear = useCallback(() => {
		cancel();
		setError(null);
		setContext(null);
		setMarkdown("");
		setResult(null);
		setStatus("Ready to generate");
		latestStatusRef.current = "Ready to generate";
	}, [cancel, setError]);

	return {
		clear,
		context,
		error,
		loading,
		markdown,
		result,
		restore,
		run,
		status,
	};
}

function TodayRoute() {
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<TodayRouteView
			searchState={search}
			onSearchChange={(next, options) =>
				void navigate({ search: next, replace: options?.replace })
			}
		/>
	);
}

interface DailyDigestHistoryListResponse {
	items: DailyDigestHistoryListItem[];
}

interface DailyDigestHistoryDetailResponse {
	item: {
		metadata: DailyDigestHistoryListItem;
		result: PeriodDigestRunResult;
	};
}

async function digestHistoryResponseError(response: Response) {
	try {
		const payload = (await response.json()) as { message?: unknown };
		if (typeof payload.message === "string" && payload.message.trim()) {
			return payload.message;
		}
	} catch {
		// Fall through to a status-based message.
	}
	return `Digest history request failed (${String(response.status)})`;
}

export function TodayRouteView({
	searchState: controlledSearch,
	onSearchChange,
}: {
	searchState?: TodayRouteSearch;
	onSearchChange?: RouteSearchChange<TodayRouteSearch>;
} = {}) {
	const [localSearch, setLocalSearch] = useState(() => validateTodaySearch({}));
	const searchState = controlledSearch ?? localSearch;
	const updateSearch: RouteSearchChange<TodayRouteSearch> = (next, options) =>
		onSearchChange ? onSearchChange(next, options) : setLocalSearch(next);
	const {
		run: activeHistoryId,
		archive: historyKind,
		period,
		since,
		until,
		includeDms,
		includeFeed,
	} = searchState;
	const historyEnabled = Boolean(controlledSearch && onSearchChange);
	const [customRangeOpen, setCustomRangeOpen] = useState(
		() => period === "custom",
	);
	const [historyItems, setHistoryItems] = useState<
		DailyDigestHistoryListItem[]
	>([]);
	const [historyFilter, setHistoryFilter] = useState("");
	const [historyLoading, setHistoryLoading] = useState(historyEnabled);
	const [historyError, setHistoryError] = useState<string | null>(null);
	const [historyRestoreLoading, setHistoryRestoreLoading] = useState(false);
	const [historyRestoreError, setHistoryRestoreError] = useState<string | null>(
		null,
	);
	const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false);
	const historyLoadSequence = useRef(0);
	const historyButtonRef = useRef<HTMLButtonElement>(null);
	const historyDialogRef = useRef<HTMLDivElement>(null);
	const {
		clear,
		context,
		error,
		loading,
		markdown,
		result,
		restore,
		run,
		status,
	} = useDigestStream(period, includeDms, includeFeed, since, until);
	const loadHistory = useCallback(async () => {
		if (!historyEnabled) return;
		const sequence = ++historyLoadSequence.current;
		setHistoryLoading(true);
		setHistoryError(null);
		try {
			const historyEndpoint =
				historyKind === "weekly"
					? "/api/weekly-digest-history?limit=260"
					: `/api/period-digest-history?limit=366&kind=${historyKind}`;
			const response = await fetch(historyEndpoint, {
				cache: "no-store",
			});
			if (!response.ok)
				throw new Error(await digestHistoryResponseError(response));
			const payload = (await response.json()) as DailyDigestHistoryListResponse;
			if (sequence === historyLoadSequence.current) {
				setHistoryItems(payload.items);
			}
		} catch (cause) {
			if (sequence === historyLoadSequence.current) {
				setHistoryError(
					cause instanceof Error
						? cause.message
						: "Could not load digest history",
				);
			}
		} finally {
			if (sequence === historyLoadSequence.current) {
				setHistoryLoading(false);
			}
		}
	}, [historyEnabled, historyKind]);

	useEffect(() => {
		void loadHistory();
		if (!historyEnabled) return;
		const interval = window.setInterval(() => void loadHistory(), 60_000);
		return () => window.clearInterval(interval);
	}, [historyEnabled, loadHistory]);

	useEffect(() => {
		if (!historyEnabled || !activeHistoryId) return;
		const controller = new AbortController();
		setHistoryRestoreLoading(true);
		setHistoryRestoreError(null);
		const historyEndpoint =
			historyKind === "weekly"
				? "/api/weekly-digest-history"
				: "/api/period-digest-history";
		void fetch(`${historyEndpoint}?id=${encodeURIComponent(activeHistoryId)}`, {
			cache: "no-store",
			signal: controller.signal,
		})
			.then(async (response) => {
				if (!response.ok) {
					throw new Error(await digestHistoryResponseError(response));
				}
				return (await response.json()) as DailyDigestHistoryDetailResponse;
			})
			.then(({ item }) => {
				if (controller.signal.aborted) return;
				restore(item.result);
			})
			.catch((cause: unknown) => {
				if (controller.signal.aborted) return;
				setHistoryRestoreError(
					cause instanceof Error
						? cause.message
						: "Could not restore digest history",
				);
			})
			.finally(() => {
				if (!controller.signal.aborted) setHistoryRestoreLoading(false);
			});
		return () => controller.abort();
	}, [activeHistoryId, historyEnabled, historyKind, restore]);

	const closeHistoryDrawer = useCallback(() => {
		setHistoryDrawerOpen(false);
		window.setTimeout(() => historyButtonRef.current?.focus(), 0);
	}, []);

	useEffect(() => {
		if (!historyDrawerOpen) return;
		historyDialogRef.current?.focus();
		function closeOnEscape(event: KeyboardEvent) {
			if (event.key === "Escape") closeHistoryDrawer();
		}
		window.addEventListener("keydown", closeOnEscape);
		return () => window.removeEventListener("keydown", closeOnEscape);
	}, [closeHistoryDrawer, historyDrawerOpen]);

	function selectHistory(id: string) {
		setHistoryDrawerOpen(false);
		if (id === activeHistoryId) return;
		clear();
		updateSearch({ ...searchState, archive: historyKind, run: id });
	}

	function changeHistoryKind(kind: "daily" | "intraday" | "weekly") {
		if (kind === historyKind) return;
		historyLoadSequence.current += 1;
		setHistoryItems([]);
		setHistoryFilter("");
		setHistoryError(null);
		setHistoryRestoreError(null);
		setHistoryRestoreLoading(false);
		clear();
		updateSearch({ ...searchState, archive: kind, run: "" });
	}

	function showLivePeriod(next: TodayRouteSearch) {
		clear();
		updateSearch({ ...next, run: "" });
	}

	useEffect(() => {
		setCustomRangeOpen(period === "custom");
	}, [period]);
	const sourceLabel = useMemo(
		() => formatCounts(result?.context ?? context),
		[context, result],
	);
	const displayMarkdown = useMemo(
		() =>
			result
				? injectTopicHeadings(markdown, result.digest.keyTopics)
				: markdown,
		[markdown, result],
	);
	const screenReferenceGroups = useMemo(() => {
		const groupsByTitle = new Map<string, ReferenceGroup>();
		if (!result) return groupsByTitle;
		for (const group of collectReferenceGroups(result, displayMarkdown)) {
			if (
				group.section === "Supplemental source list" ||
				referenceSourcesForGroup(group).length === 0
			) {
				continue;
			}
			const key = normalizeReferenceTitle(group.title);
			const existing = groupsByTitle.get(key);
			if (existing) {
				existing.tweetIds = [
					...new Set([...existing.tweetIds, ...group.tweetIds]),
				];
				existing.feedItemIds = [
					...new Set([...existing.feedItemIds, ...group.feedItemIds]),
				];
				continue;
			}
			groupsByTitle.set(key, {
				...group,
				tweetIds: [...group.tweetIds],
				feedItemIds: [...group.feedItemIds],
			});
		}
		return groupsByTitle;
	}, [displayMarkdown, result]);
	const renderDigestHeadingSupplement = useCallback(
		({ level, text }: { level: 2 | 3; text: string }) => {
			if (level !== 3 || !result) return null;
			const group = screenReferenceGroups.get(normalizeReferenceTitle(text));
			return group ? <TodayTopicSources group={group} result={result} /> : null;
		},
		[result, screenReferenceGroups],
	);
	const digestLabel =
		result?.context.window.label ??
		context?.window.label ??
		periodLabel(period);
	const canExportPdf =
		Boolean(markdown.trim()) && !loading && !historyRestoreLoading;
	const canExportReferencePdf =
		Boolean(result) && !loading && !historyRestoreLoading;
	const exportTitle = `BirdClaw ${digestLabel} digest`;
	const referenceExportTitle = `BirdClaw ${digestLabel} reference collection`;
	const exportUpdatedAt = result
		? new Date(result.updatedAt).toLocaleString(undefined, {
				dateStyle: "medium",
				timeStyle: "short",
			})
		: null;
	const referenceGeneratedAt = result
		? new Date(result.updatedAt).toLocaleDateString(undefined, {
				dateStyle: "medium",
			})
		: null;
	const [referencePdfActive, setReferencePdfActive] = useState(false);
	const [referencePdfError, setReferencePdfError] = useState<string | null>(
		null,
	);
	const refreshAfterHistoryRef = useRef(false);
	const handleExportPdf = useCallback(() => {
		if (!canExportPdf) return;
		exportCurrentPdf(exportTitle);
	}, [canExportPdf, exportTitle]);
	const handleExportReferencePdf = useCallback(() => {
		if (!canExportReferencePdf || !result || referencePdfActive) return;
		flushSync(() => {
			setReferencePdfActive(true);
		});
		setReferencePdfError(null);
		void (async () => {
			try {
				// Let the busy state paint before image preparation and Paged.js start.
				await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
				if (
					typeof CSS === "undefined" ||
					typeof CSS.supports !== "function" ||
					!CSS.supports("page", "reference")
				) {
					exportCurrentPdf(referenceExportTitle, "reference", () =>
						setReferencePdfActive(false),
					);
					return;
				}
				await exportReferenceCollectionPdf({
					title: referenceExportTitle,
					sourceSelector: '[data-testid="today-reference-pdf"]',
					onCleanup: () => setReferencePdfActive(false),
				});
			} catch {
				setReferencePdfError("完整 PDF 暂时无法导出，请重试");
				setReferencePdfActive(false);
			}
		})();
	}, [canExportReferencePdf, referenceExportTitle, referencePdfActive, result]);
	const handleRefreshDigest = useCallback(() => {
		if (activeHistoryId) {
			refreshAfterHistoryRef.current = true;
			clear();
			updateSearch({ ...searchState, run: "" });
			return;
		}
		run(Boolean(result));
	}, [activeHistoryId, clear, result, run, searchState, updateSearch]);

	useEffect(() => {
		if (activeHistoryId || !refreshAfterHistoryRef.current) return;
		refreshAfterHistoryRef.current = false;
		run(true);
	}, [activeHistoryId, run]);

	return (
		<div className="grid min-h-screen min-w-0 min-[1240px]:grid-cols-[minmax(0,680px)_minmax(280px,1fr)]">
			<section className="today-pdf-root flex min-h-screen min-w-0 flex-col">
				<header className={cx("today-pdf-header", pageHeaderClass)}>
					<div className={cx(pageHeaderRowClass, "flex-wrap")}>
						<div className="min-w-0 max-sm:w-full">
							<h1 className={pageTitleClass}>What happened</h1>
							<p className={pageSubtitleClass}>{sourceLabel}</p>
						</div>
						<div
							className={cx(
								"today-screen-only max-w-full overflow-x-auto max-sm:w-full max-sm:flex-wrap max-sm:overflow-visible [&>button]:shrink-0",
								pageHeaderActionsClass,
							)}
						>
							<button
								ref={historyButtonRef}
								type="button"
								className={cx(secondaryButtonClass, "min-[1240px]:hidden")}
								onClick={() => setHistoryDrawerOpen(true)}
							>
								<History className="size-4" aria-hidden="true" />
								History
							</button>
							<button
								type="button"
								className={secondaryButtonClass}
								onClick={handleExportPdf}
								disabled={!canExportPdf}
							>
								<FileDown className="size-4" aria-hidden="true" />
								Export PDF
							</button>
							<button
								type="button"
								className={secondaryButtonClass}
								onClick={handleExportReferencePdf}
								disabled={!canExportReferencePdf || referencePdfActive}
							>
								{referencePdfActive ? (
									<Loader2 className="size-4 animate-spin" aria-hidden="true" />
								) : (
									<FileText className="size-4" aria-hidden="true" />
								)}
								{referencePdfActive ? "正在准备完整 PDF…" : "导出完整 PDF"}
							</button>
							<button
								type="button"
								className={secondaryButtonClass}
								onClick={handleRefreshDigest}
								disabled={loading || historyRestoreLoading}
							>
								{result || activeHistoryId ? (
									<RefreshCw
										className={cx("size-4", loading && "animate-spin")}
										aria-hidden="true"
									/>
								) : (
									<Sparkles className="size-4" aria-hidden="true" />
								)}
								{result || activeHistoryId ? "Refresh" : "Generate summary"}
							</button>
						</div>
					</div>
					<div className="today-pdf-meta" aria-hidden="true">
						<span>{digestLabel}</span>
						<span>·</span>
						<span>Sources: {sourceLabel}</span>
						{exportUpdatedAt ? (
							<>
								<span>·</span>
								<span>Generated {exportUpdatedAt}</span>
							</>
						) : null}
					</div>
					<div className="today-screen-only flex flex-wrap items-center gap-2 px-4 pb-3">
						<div
							className={cx(
								segmentedClass,
								"max-w-full overflow-x-auto max-sm:grid max-sm:w-full max-sm:grid-cols-3 max-sm:overflow-visible max-sm:rounded-2xl",
							)}
							aria-label="Digest period"
						>
							{periods.map((item) => (
								<button
									key={item.value}
									type="button"
									className={cx(
										segmentClass,
										(item.value === "custom"
											? period === "custom" || customRangeOpen
											: !customRangeOpen && period === item.value) &&
											todayPeriodSegmentActiveClass,
									)}
									onClick={() => {
										if (item.value === "custom") {
											setCustomRangeOpen((open) => !open);
											return;
										}
										setCustomRangeOpen(false);
										showLivePeriod({
											...searchState,
											period: item.value,
											since: "",
											until: "",
										});
									}}
								>
									{item.label}
								</button>
							))}
						</div>
						<label className="inline-flex min-h-11 items-center gap-2 rounded-full border border-[var(--line)] px-3 py-2 text-[13px] font-medium text-[var(--ink-soft)]">
							<input
								type="checkbox"
								checked={includeFeed}
								onChange={(event) =>
									showLivePeriod({
										...searchState,
										includeFeed: event.currentTarget.checked,
									})
								}
							/>
							Feed
						</label>
						<label className="inline-flex min-h-11 items-center gap-2 rounded-full border border-[var(--line)] px-3 py-2 text-[13px] font-medium text-[var(--ink-soft)]">
							<input
								type="checkbox"
								checked={includeDms}
								onChange={(event) =>
									showLivePeriod({
										...searchState,
										includeDms: event.currentTarget.checked,
									})
								}
							/>
							DMs
						</label>
						{customRangeOpen ? (
							<CustomDateRangePicker
								value={period === "custom" ? { since, until } : null}
								onApply={(customRange) =>
									showLivePeriod({
										...searchState,
										period: "custom",
										...customRange,
									})
								}
							/>
						) : null}
					</div>
				</header>

				{error || historyRestoreError || referencePdfError ? (
					<div
						className={cx(
							errorCopyClass,
							"flex items-center justify-between gap-3",
						)}
						role="alert"
					>
						<span>{error ?? historyRestoreError ?? referencePdfError}</span>
						<button
							className="shrink-0 font-semibold underline underline-offset-2"
							onClick={
								referencePdfError
									? handleExportReferencePdf
									: handleRefreshDigest
							}
							type="button"
						>
							Retry
						</button>
					</div>
				) : null}

				<div className="today-screen-only border-b border-[var(--line)] px-4 py-2 text-[13px] text-[var(--ink-soft)]">
					<span className="inline-flex items-center gap-1">
						{historyRestoreLoading ? (
							<Loader2 className="size-4 animate-spin" aria-hidden="true" />
						) : loading ? (
							<Loader2 className="size-4 animate-spin" aria-hidden="true" />
						) : markdown ? (
							<CheckCircle2 className="size-4" aria-hidden="true" />
						) : (
							<Sparkles className="size-4" aria-hidden="true" />
						)}
						{historyRestoreLoading
							? `Restoring ${historyKind} history`
							: loading
								? status
								: activeHistoryId && result
									? `Restored from ${historyKind} history · 0 token`
									: result
										? `${result.cached ? "Cached" : "Ready"} · ${result.context.window.label}`
										: error
											? "Digest failed"
											: "On demand · 0 tokens used"}
					</span>
				</div>

				{referencePdfActive && result ? (
					<ReferenceDigestPrint
						generatedAt={referenceGeneratedAt}
						markdown={displayMarkdown}
						result={result}
					/>
				) : null}

				{markdown ? (
					<MarkdownViewer
						className="today-digest-pdf"
						context={result?.context ?? context}
						markdownLinkClassName={todayMarkdownLinkClass}
						markdown={displayMarkdown}
						renderHeadingSupplement={renderDigestHeadingSupplement}
						sourceOnlyCitations
					/>
				) : (
					<div className="px-4 py-5 text-[14px] text-[var(--ink-soft)]">
						{loading
							? status
							: error
								? "No digest was generated. Retry to start a new run."
								: "No summary yet. Choose a period, then generate only when you need it."}
					</div>
				)}
			</section>

			<div className="today-screen-only sticky top-0 hidden h-screen min-h-0 border-l border-[var(--line)] min-[1240px]:block">
				<DailyDigestHistoryPanel
					activeId={activeHistoryId}
					error={historyError}
					filter={historyFilter}
					items={historyItems}
					kind={historyKind}
					loading={historyLoading}
					onFilterChange={setHistoryFilter}
					onKindChange={changeHistoryKind}
					onSelect={selectHistory}
				/>
			</div>

			{historyDrawerOpen ? (
				<div className="today-screen-only fixed inset-0 z-50 min-[1240px]:hidden">
					<button
						type="button"
						aria-label="Close digest history overlay"
						className="absolute inset-0 bg-black/40"
						onClick={closeHistoryDrawer}
					/>
					<div
						ref={historyDialogRef}
						role="dialog"
						aria-modal="true"
						aria-label="Digest history"
						className="absolute inset-y-0 right-0 h-full w-[min(360px,calc(100%-32px))] border-l border-[var(--line)] bg-[var(--bg)] shadow-[-12px_0_32px_rgba(0,0,0,0.18)] outline-none"
						tabIndex={-1}
					>
						<DailyDigestHistoryPanel
							activeId={activeHistoryId}
							error={historyError}
							filter={historyFilter}
							items={historyItems}
							kind={historyKind}
							loading={historyLoading}
							onClose={closeHistoryDrawer}
							onFilterChange={setHistoryFilter}
							onKindChange={changeHistoryKind}
							onSelect={selectHistory}
						/>
					</div>
				</div>
			) : null}
		</div>
	);
}
