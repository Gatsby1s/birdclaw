import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
	FileText,
	CheckCircle2,
	FileDown,
	Loader2,
	RefreshCw,
	Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { MarkdownViewer } from "#/components/MarkdownViewer";
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
	hydrateProfileHandles,
	normalizeProfileHydrationHandle as normalizeHandle,
} from "#/lib/profile-hydration-client";
import {
	type PeriodRouteSearch,
	type RouteSearchChange,
	type TodayRouteSearch,
	validateTodaySearch,
} from "#/lib/route-search";
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
type TodayPrintMode = "summary" | "reference";
type ReferenceTweet = PeriodDigestContext["tweets"][number];
type ReferenceDm = PeriodDigestContext["dms"][number];
type ReferenceGroup = {
	section: string;
	title: string;
	summary: string;
	tweetIds: string[];
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
];

const referenceSectionLabels: Record<string, string> = {
	"What people are talking about": "热议主题",
	"Important links shared": "重要链接",
	"Action items": "行动线索",
	"Worth opening": "值得细读",
	"Supplemental source list": "补充来源",
};

function periodLabel(period: PeriodOption) {
	return periods.find((item) => item.value === period)?.label ?? "Digest";
}

function exportCurrentDigestPdf(
	title: string,
	mode: TodayPrintMode = "summary",
	onCleanup?: () => void,
) {
	const previousTitle = document.title;
	const previousPrintMode = document.body.dataset.todayPrintMode;
	let cleanedUp = false;
	const cleanup = () => {
		if (cleanedUp) return;
		cleanedUp = true;
		document.title = previousTitle;
		if (previousPrintMode === undefined) {
			delete document.body.dataset.todayPrintMode;
		} else {
			document.body.dataset.todayPrintMode = previousPrintMode;
		}
		window.removeEventListener("afterprint", cleanup);
		onCleanup?.();
	};

	document.title = title;
	document.body.dataset.todayPrintMode = mode;
	window.addEventListener("afterprint", cleanup, { once: true });
	window.setTimeout(cleanup, 3000);
	window.print();
}

function digestUrl(
	period: PeriodOption,
	includeDms: boolean,
	refresh: boolean,
) {
	const url = new URL("/api/period-digest", window.location.origin);
	url.searchParams.set("period", period);
	url.searchParams.set("includeDms", String(includeDms));
	url.searchParams.set("maxTweets", "5000");
	url.searchParams.set("maxLinks", "20");
	// Cloudflare caps proxied requests; live timeline sync remains a separate job/UI action.
	url.searchParams.set("liveSync", "false");
	if (refresh) {
		url.searchParams.set("refresh", "true");
	}
	return url;
}

function digestStreamError(cause: unknown, phase: string) {
	const message = cause instanceof Error ? cause.message : String(cause);
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
	if (!context) return "Local Twitter memory, summarized as it streams.";
	const counts = context.counts;
	return [
		`${String(counts.home)} home`,
		`${String(counts.mentions)} mentions`,
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

function markdownReferenceSectionHeading(line: string) {
	const markdownHeading = /^##(?!#)\s+(.+?)\s*#*\s*$/.exec(line);
	if (markdownHeading?.[1]) {
		return markdownReferencePlainText(markdownHeading[1]);
	}
	const boldHeading = /^\*\*([^*]+)\*\*$/.exec(line);
	const boldTitle = boldHeading?.[1]
		? markdownReferencePlainText(boldHeading[1])
		: "";
	return boldTitle && referenceSectionLabels[boldTitle] ? boldTitle : null;
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
		summary: markdownReferencePlainText(summary.join(" ")) || fallbackSummary,
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

function collectStructuredReferenceGroups(result: PeriodDigestRunResult) {
	const groups: ReferenceGroup[] = [];
	for (const topic of result.digest.keyTopics) {
		if (topic.tweetIds.length === 0) continue;
		groups.push({
			section: "What people are talking about",
			title: topic.title,
			summary: topic.summary,
			tweetIds: topic.tweetIds,
		});
	}
	for (const link of result.digest.notableLinks) {
		if (link.sourceTweetIds.length === 0) continue;
		groups.push({
			section: "Important links shared",
			title: link.title,
			summary: link.why,
			tweetIds: link.sourceTweetIds,
		});
	}
	for (const action of result.digest.actionItems) {
		if (!action.tweetId) continue;
		groups.push({
			section: "Action items",
			title: action.label,
			summary: action.kind.replace("_", " "),
			tweetIds: [action.tweetId],
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
		});
	}
	return groups;
}

function collectMarkdownReferenceGroups(
	markdown: string,
	sourceTweetIds: string[],
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
		if (tweetIds.length === 0) {
			topicTitle = "";
			continue;
		}

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
		}
		groups.push({ section, title, summary, tweetIds });
		topicTitle = "";
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
	);
	return markdownGroups.length > 0
		? markdownGroups
		: collectStructuredReferenceGroups(result);
}

function collectReferenceLabels(groups: ReferenceGroup[]) {
	const orderedIds: string[] = [];
	const labelsById = new Map<string, string>();
	for (const group of groups) {
		for (const tweetId of group.tweetIds) {
			const normalized = normalizeReferenceTweetId(tweetId);
			if (labelsById.has(normalized)) continue;
			orderedIds.push(normalized);
			labelsById.set(
				normalized,
				`S${String(orderedIds.length).padStart(2, "0")}`,
			);
		}
	}
	return { orderedIds, labelsById };
}

function groupReferenceSections(groups: ReferenceGroup[]) {
	const sections: Array<{ title: string; groups: ReferenceGroup[] }> = [];
	for (const group of groups) {
		const title = referenceSectionLabels[group.section] ?? group.section;
		const current = sections.at(-1);
		if (current?.title === title) {
			current.groups.push(group);
		} else {
			sections.push({ title, groups: [group] });
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
	return tweet.name && tweet.name !== tweet.author
		? `${tweet.name} (${handle})`
		: handle;
}

function formatReferenceDate(value: string) {
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) return "";
	return parsed.toLocaleDateString(undefined, { dateStyle: "medium" });
}

function compactReferenceUrl(value: string) {
	try {
		const url = new URL(value);
		return url.hostname.replace(/^www\./, "") + url.pathname.replace(/\/$/, "");
	} catch {
		return value;
	}
}

function isReferenceOwnTweetUrl(value: string, tweet: ReferenceTweet) {
	const tweetId = normalizeReferenceTweetId(tweet.id);
	try {
		const url = new URL(value);
		const host = url.hostname.replace(/^www\./, "");
		if (host !== "x.com" && host !== "twitter.com") return false;
		return new RegExp(
			`/status/${tweetId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/|$)`,
		).test(url.pathname);
	} catch {
		return false;
	}
}

function referenceLinkLabels(tweet: ReferenceTweet) {
	return (tweet.entities?.urls ?? [])
		.filter((item) => !isReferenceOwnTweetUrl(item.expandedUrl, tweet))
		.map((item) => item.displayUrl || compactReferenceUrl(item.expandedUrl))
		.filter(Boolean)
		.slice(0, 4);
}

function ReferenceTweetCard({
	label,
	tweet,
}: {
	label: string;
	tweet: ReferenceTweet | null;
}) {
	if (!tweet) {
		return (
			<section className="today-reference-source">
				<div className="today-reference-source-head">
					<span className="today-reference-badge">{label}</span>
					<strong>缺失原文</strong>
				</div>
				<p>当前缓存结果里没有这条来源的正文。</p>
			</section>
		);
	}
	const linkLabels = referenceLinkLabels(tweet);
	return (
		<section className="today-reference-source">
			<div className="today-reference-source-head">
				<span className="today-reference-badge">{label}</span>
				<strong>{formatReferenceAuthor(tweet)}</strong>
				{tweet.createdAt ? (
					<span>{formatReferenceDate(tweet.createdAt)}</span>
				) : null}
			</div>
			<p>{tweet.text || "(empty text)"}</p>
			{tweet.replyToTweet ? (
				<blockquote>
					回复上下文：@
					{tweet.replyToTweet.author}
					{" · "}
					{tweet.replyToTweet.text}
				</blockquote>
			) : null}
			{linkLabels.length > 0 ? (
				<p className="today-reference-links">材料：{linkLabels.join(" · ")}</p>
			) : null}
		</section>
	);
}

function ReferenceDmCard({ item }: { item: ReferenceDm }) {
	return (
		<section className="today-reference-source">
			<div className="today-reference-source-head">
				<span className="today-reference-badge">DM</span>
				<strong>{item.name || item.participant}</strong>
			</div>
			<p>{item.text || "(empty message)"}</p>
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
	const { labelsById, orderedIds } = collectReferenceLabels(groups);
	const sourceCount = orderedIds.length;
	return (
		<article
			aria-label="参考内容合集"
			className="today-reference-pdf"
			data-testid="today-reference-pdf"
		>
			<header className="today-reference-cover">
				<p className="today-reference-eyebrow">参考内容合集</p>
				<h1>{documentMeta.title}</h1>
				<p>{documentMeta.summary}</p>
				<dl>
					<div>
						<dt>窗口</dt>
						<dd>{result.context.window.label}</dd>
					</div>
					<div>
						<dt>来源</dt>
						<dd>{String(sourceCount)} 条引用原文</dd>
					</div>
					{generatedAt ? (
						<div>
							<dt>生成</dt>
							<dd>{generatedAt}</dd>
						</div>
					) : null}
				</dl>
			</header>

			<section className="today-reference-section">
				<h2>阅读导航</h2>
				{groups.length > 0 ? (
					<ol className="today-reference-nav">
						{groups.map((group, index) => (
							<li key={`${group.section}-${group.title}-${String(index)}`}>
								<strong>{group.title}</strong>
								<span>
									{group.tweetIds
										.map((tweetId) =>
											labelsById.get(normalizeReferenceTweetId(tweetId)),
										)
										.filter(Boolean)
										.join(" · ")}
								</span>
							</li>
						))}
					</ol>
				) : (
					<p>当前 digest 没有可映射的引用来源。</p>
				)}
			</section>

			{sections.map((section) => (
				<section className="today-reference-section" key={section.title}>
					<h2>{section.title}</h2>
					{section.groups.map((group, index) => (
						<section
							className="today-reference-group"
							key={`${section.title}-${group.title}-${String(index)}`}
						>
							<h3>{group.title}</h3>
							<p>{group.summary}</p>
							<p className="today-reference-source-list">
								本组原文：
								{group.tweetIds
									.map((tweetId) =>
										labelsById.get(normalizeReferenceTweetId(tweetId)),
									)
									.filter(Boolean)
									.join(" · ")}
							</p>
							{group.tweetIds.map((tweetId) => {
								const normalized = normalizeReferenceTweetId(tweetId);
								return (
									<ReferenceTweetCard
										key={normalized}
										label={labelsById.get(normalized) ?? normalized}
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

			{orderedIds.length > 0 ? (
				<section className="today-reference-section">
					<h2>来源索引</h2>
					<ol className="today-reference-index">
						{orderedIds.map((tweetId) => {
							const tweet = referenceTweetFor(tweetLookup, tweetId);
							return (
								<li key={tweetId}>
									<span>{labelsById.get(tweetId)}</span>
									<strong>
										{tweet ? formatReferenceAuthor(tweet) : "缺失原文"}
									</strong>
									<small>{tweet?.id ?? tweetId}</small>
								</li>
							);
						})}
					</ol>
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

function useDigestStream(period: PeriodOption, includeDms: boolean) {
	const queryClient = useQueryClient();
	const [markdown, setMarkdown] = useState("");
	const [context, setContext] = useState<PeriodDigestContext | null>(null);
	const [result, setResult] = useState<PeriodDigestRunResult | null>(null);
	const [status, setStatus] = useState("Starting digest");
	const latestStatusRef = useRef("Starting digest");

	const onStart = useCallback(() => {
		setMarkdown("");
		setContext(null);
		setResult(null);
		setStatus("Starting digest");
		latestStatusRef.current = "Starting digest";
	}, []);
	const request = useCallback(
		(signal: AbortSignal, refresh: boolean) =>
			fetch(digestUrl(period, includeDms, refresh), {
				cache: "no-store",
				signal,
			}),
		[includeDms, period],
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
	const { error, loading, run } = useNdjsonRun({
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
		run(false);
	}, [run]);

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

	return { context, error, loading, markdown, result, run, status };
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
	const { period, includeDms } = searchState;
	const { context, error, loading, markdown, result, run, status } =
		useDigestStream(period, includeDms);
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
	const digestLabel =
		result?.context.window.label ??
		context?.window.label ??
		periodLabel(period);
	const canExportPdf = Boolean(markdown.trim()) && !loading;
	const canExportReferencePdf = Boolean(result) && !loading;
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
	const handleExportPdf = useCallback(() => {
		if (!canExportPdf) return;
		exportCurrentDigestPdf(exportTitle);
	}, [canExportPdf, exportTitle]);
	const handleExportReferencePdf = useCallback(() => {
		if (!canExportReferencePdf || !result) return;
		flushSync(() => setReferencePdfActive(true));
		exportCurrentDigestPdf(referenceExportTitle, "reference", () =>
			setReferencePdfActive(false),
		);
	}, [canExportReferencePdf, referenceExportTitle, result]);

	return (
		<div className="today-pdf-root flex min-h-screen flex-col">
			<header className={cx("today-pdf-header", pageHeaderClass)}>
				<div className={pageHeaderRowClass}>
					<div className="min-w-0">
						<h1 className={pageTitleClass}>What happened</h1>
						<p className={pageSubtitleClass}>{sourceLabel}</p>
					</div>
					<div className={cx("today-screen-only", pageHeaderActionsClass)}>
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
							disabled={!canExportReferencePdf}
						>
							<FileText className="size-4" aria-hidden="true" />
							导出完整 PDF
						</button>
						<button
							type="button"
							className={secondaryButtonClass}
							onClick={() => run(true)}
							disabled={loading}
						>
							<RefreshCw
								className={cx("size-4", loading && "animate-spin")}
								aria-hidden="true"
							/>
							Refresh
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
					<div className={segmentedClass} aria-label="Digest period">
						{periods.map((item) => (
							<button
								key={item.value}
								type="button"
								className={cx(
									segmentClass,
									period === item.value && todayPeriodSegmentActiveClass,
								)}
								onClick={() =>
									updateSearch({ ...searchState, period: item.value })
								}
							>
								{item.label}
							</button>
						))}
					</div>
					<label className="inline-flex items-center gap-2 rounded-full border border-[var(--line)] px-3 py-1 text-[13px] font-medium text-[var(--ink-soft)]">
						<input
							type="checkbox"
							checked={includeDms}
							onChange={(event) =>
								updateSearch({
									...searchState,
									includeDms: event.currentTarget.checked,
								})
							}
						/>
						DMs
					</label>
				</div>
			</header>

			{error ? (
				<div
					className={cx(
						errorCopyClass,
						"flex items-center justify-between gap-3",
					)}
					role="alert"
				>
					<span>{error}</span>
					<button
						className="shrink-0 font-semibold underline underline-offset-2"
						onClick={() => run(true)}
						type="button"
					>
						Retry
					</button>
				</div>
			) : null}

			<div className="today-screen-only border-b border-[var(--line)] px-4 py-2 text-[13px] text-[var(--ink-soft)]">
				<span className="inline-flex items-center gap-1">
					{loading ? (
						<Loader2 className="size-4 animate-spin" aria-hidden="true" />
					) : markdown ? (
						<CheckCircle2 className="size-4" aria-hidden="true" />
					) : (
						<Sparkles className="size-4" aria-hidden="true" />
					)}
					{loading
						? status
						: result
							? `${result.cached ? "Cached" : "Ready"} · ${result.context.window.label}`
							: error
								? "Digest failed"
								: "Ready"}
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
					sourceOnlyCitations
				/>
			) : (
				<div className="px-4 py-5 text-[14px] text-[var(--ink-soft)]">
					{loading
						? status
						: error
							? "No digest was generated. Retry to start a new run."
							: "Waiting for the first tokens..."}
				</div>
			)}
		</div>
	);
}
