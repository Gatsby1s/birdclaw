import { createFileRoute } from "@tanstack/react-router";
import {
	ChevronDown,
	CheckCircle2,
	FileDown,
	FileText,
	Loader2,
	RefreshCw,
	Search,
	Sparkles,
} from "lucide-react";
import {
	type FormEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { CustomDateRangePicker } from "#/components/CustomDateRangePicker";
import { flushSync } from "react-dom";
import { MarkdownViewer } from "#/components/MarkdownViewer";
import {
	ReferenceCollectionPrint,
	type ReferenceCollectionGroup,
} from "#/components/ReferenceCollectionPrint";
import { useNdjsonRun } from "#/components/useNdjsonRun";
import type {
	SearchDiscussionContext,
	SearchDiscussionRunResult,
	SearchDiscussionSource,
	SearchDiscussionStreamEvent,
} from "#/lib/search-discussion";
import {
	isTerminalStreamEvent,
	searchDiscussionStreamEventSchema,
} from "#/lib/client-stream-contracts";
import {
	type DiscussDateRange,
	resolveDiscussDateRange,
} from "#/lib/discuss-date-range";
import type { TweetSearchMode } from "#/lib/tweet-search-live";
import {
	exportCurrentPdf,
	exportReferenceCollectionPdf,
} from "#/lib/pdf-export-client";
import {
	type DiscussRouteSearch,
	type RouteSearchChange,
	validateDiscussSearch,
} from "#/lib/route-search";
import {
	cx,
	errorCopyClass,
	pageHeaderActionsClass,
	pageHeaderClass,
	pageHeaderRowClass,
	pageSubtitleClass,
	pageTitleClass,
	primaryButtonClass,
	searchFieldIconClass,
	searchFieldInputClass,
	searchFieldShellClass,
	secondaryButtonClass,
	segmentClass,
	segmentedClass,
	selectFieldClass,
	textFieldClass,
} from "#/lib/ui";

export const Route = createFileRoute("/discuss")({
	component: DiscussRoute,
	validateSearch: validateDiscussSearch,
});

const sources: Array<{ value: SearchDiscussionSource; label: string }> = [
	{ value: "search", label: "Live search" },
	{ value: "all", label: "All local" },
	{ value: "home", label: "Home" },
	{ value: "mentions", label: "Mentions" },
	{ value: "authored", label: "Authored" },
	{ value: "likes", label: "Likes" },
	{ value: "bookmarks", label: "Bookmarks" },
];

const modes: Array<{ value: TweetSearchMode; label: string }> = [
	{ value: "auto", label: "Auto" },
	{ value: "bird", label: "Bird" },
	{ value: "xurl", label: "xurl" },
	{ value: "local", label: "Local" },
];
const ranges: Array<{ value: DiscussDateRange; label: string }> = [
	{ value: "all", label: "All" },
	{ value: "today", label: "Today" },
	{ value: "24h", label: "24h" },
	{ value: "yesterday", label: "Yesterday" },
	{ value: "week", label: "Week" },
	{ value: "custom", label: "Custom" },
];
const DISCUSS_SEARCH_LIMIT = 20_000;
const DISCUSS_MAX_PAGES = 200;
const discussRangeSegmentActiveClass =
	"!bg-[var(--accent)] !text-[var(--accent-text)] shadow-[0_0_0_1px_color-mix(in_srgb,var(--accent)_35%,transparent)]";
const discussMarkdownLinkClass =
	"text-[var(--ink)] underline-offset-2 hover:underline";

function discussionPrematureEofError() {
	return new Error(
		"Discussion connection closed before completion. Retry to continue.",
	);
}

function discussionStreamError(cause: unknown) {
	return cause instanceof Error ? cause.message : "Discussion failed";
}

function discussionUrl(
	query: string,
	options: {
		source: SearchDiscussionSource;
		mode: TweetSearchMode;
		dateRange: ReturnType<typeof resolveDiscussDateRange>;
		includeDms: boolean;
		question: string;
		refresh: boolean;
	},
) {
	const url = new URL("/api/search-discussion", window.location.origin);
	url.searchParams.set("query", query);
	url.searchParams.set("source", options.source);
	url.searchParams.set("mode", options.mode);
	url.searchParams.set("includeDms", String(options.includeDms));
	url.searchParams.set("limit", String(DISCUSS_SEARCH_LIMIT));
	url.searchParams.set("maxPages", String(DISCUSS_MAX_PAGES));
	if (options.dateRange.since) {
		url.searchParams.set("since", options.dateRange.since);
	}
	if (options.dateRange.until) {
		url.searchParams.set("until", options.dateRange.until);
	}
	if (options.question.trim()) {
		url.searchParams.set("question", options.question.trim());
	}
	if (options.refresh) {
		url.searchParams.set("refresh", "true");
	}
	return url;
}

function DropdownField<T extends string>({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: T;
	options: Array<{ value: T; label: string }>;
	onChange: (value: T) => void;
}) {
	return (
		<label className="relative min-w-0">
			<span className="pointer-events-none absolute left-3 top-1.5 z-10 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--ink-soft)]">
				{label}
			</span>
			<select
				aria-label={label}
				className={cx(
					selectFieldClass,
					"h-[54px] rounded-2xl bg-[var(--bg)] pb-1 pl-3 pr-9 pt-5 font-semibold text-[var(--ink)]",
				)}
				value={value}
				onChange={(event) => onChange(event.currentTarget.value as T)}
			>
				{options.map((item) => (
					<option key={item.value} value={item.value}>
						{item.label}
					</option>
				))}
			</select>
			<ChevronDown
				aria-hidden="true"
				className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-[var(--ink-soft)]"
				strokeWidth={2}
			/>
		</label>
	);
}

function formatCounts(context: SearchDiscussionContext | null) {
	if (!context) return "Live keyword search with local memory.";
	const counts = context.counts;
	const live = context.liveSearch
		? context.liveSearch.ok
			? `${context.liveSearch.source} ${String(context.liveSearch.count)} fetched`
			: `${context.liveSearch.source} failed`
		: "local";
	return [
		live,
		`${String(counts.search)} search`,
		`${String(counts.home + counts.mentions + counts.authored)} timeline`,
		`${String(counts.likes + counts.bookmarks)} saved`,
		context.includeDms ? `${String(counts.dms)} DMs` : null,
	]
		.filter(Boolean)
		.join(" · ");
}

function normalizeDiscussionReferenceId(value: string) {
	return value.trim().replace(/^tweet[_:]/, "");
}

function referenceLookupKeys(value: string, prefix: "tweet" | "dm") {
	const trimmed = value.trim();
	const withoutPrefix = trimmed.replace(new RegExp(`^${prefix}[_:]`), "");
	return [
		...new Set([
			trimmed,
			withoutPrefix,
			`${prefix}_${withoutPrefix}`,
			`${prefix}:${withoutPrefix}`,
		]),
	];
}

function knownReferenceLookup(prefix: "tweet" | "dm", knownIds: string[]) {
	const knownByKey = new Map<string, string>();
	for (const id of knownIds) {
		for (const key of referenceLookupKeys(id, prefix)) knownByKey.set(key, id);
	}
	return knownByKey;
}

function resolveKnownReferenceIds(
	values: string[],
	prefix: "tweet" | "dm",
	knownIds: string[],
) {
	const knownByKey = knownReferenceLookup(prefix, knownIds);
	const resolved: string[] = [];
	for (const value of values) {
		const id = referenceLookupKeys(value, prefix)
			.map((key) => knownByKey.get(key))
			.find((candidate): candidate is string => Boolean(candidate));
		if (id && !resolved.includes(id)) resolved.push(id);
	}
	return resolved;
}

function collectMarkdownReferenceIds(
	markdown: string,
	prefix: "tweet" | "dm",
	knownIds: string[],
) {
	const knownByKey = knownReferenceLookup(prefix, knownIds);
	const resolved: string[] = [];
	for (const match of markdown.matchAll(/[（(]([^()（）]+)[）)]/g)) {
		for (const rawToken of (match[1] ?? "").split(/[\s,，、]+/)) {
			const token = rawToken.replace(/^[`'"{}]+|[`'"{}.;]+$/g, "");
			if (!token) continue;
			const id = referenceLookupKeys(token, prefix)
				.map((key) => knownByKey.get(key))
				.find((candidate): candidate is string => Boolean(candidate));
			if (id && !resolved.includes(id)) resolved.push(id);
		}
	}
	return resolved;
}

function dedupeDiscussionTweetIds(tweetIds: string[]) {
	const seen = new Set<string>();
	return tweetIds.filter((tweetId) => {
		const normalized = normalizeDiscussionReferenceId(tweetId);
		if (seen.has(normalized)) return false;
		seen.add(normalized);
		return true;
	});
}

function collectDiscussionReferenceGroups(
	result: SearchDiscussionRunResult,
	markdown: string,
): ReferenceCollectionGroup[] {
	const groups = result.discussion.themes.map((theme) => ({
		section: "Discussion themes",
		title: theme.title,
		summary: theme.summary,
		tweetIds: dedupeDiscussionTweetIds(theme.tweetIds),
	}));
	const seen = new Set(
		groups.flatMap((group) =>
			group.tweetIds.map(normalizeDiscussionReferenceId),
		),
	);
	const referencedIds = [
		...result.discussion.sourceTweetIds,
		...collectMarkdownReferenceIds(
			markdown,
			"tweet",
			result.context.tweets.map((tweet) => tweet.id),
		),
	];
	const supplemental = referencedIds.filter((tweetId) => {
		const normalized = normalizeDiscussionReferenceId(tweetId);
		if (seen.has(normalized)) return false;
		seen.add(normalized);
		return true;
	});
	if (supplemental.length > 0) {
		groups.push({
			section: "Supplemental source list",
			title: "未在主题里直接成组的来源",
			summary: "这些来源来自当前讨论的引用集合，单独列出便于补查。",
			tweetIds: supplemental,
		});
	}
	return groups;
}

function collectDiscussionReferenceDms(
	result: SearchDiscussionRunResult,
	markdown: string,
) {
	const knownIds = result.context.dms.map((dm) => dm.id);
	const citedIds = new Set([
		...resolveKnownReferenceIds(
			[
				...result.discussion.sourceDmConversationIds,
				...result.discussion.themes.flatMap((theme) => theme.dmConversationIds),
			],
			"dm",
			knownIds,
		),
		...collectMarkdownReferenceIds(markdown, "dm", knownIds),
	]);
	return result.context.dms.filter((dm) => citedIds.has(dm.id));
}

function formatDiscussionDate(value: string | undefined) {
	if (!value) return "";
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime())
		? ""
		: parsed.toLocaleDateString("sv-SE");
}

function formatDiscussionRange(context: SearchDiscussionContext) {
	const since = formatDiscussionDate(context.since);
	const until = formatDiscussionDate(context.until);
	if (since && until) return `${since} 至 ${until}`;
	if (since) return `${since} 起`;
	if (until) return `${until} 前`;
	return "全部时间";
}

function useDiscussionStream(
	query: string,
	source: SearchDiscussionSource,
	mode: TweetSearchMode,
	dateRange: ReturnType<typeof resolveDiscussDateRange>,
	includeDms: boolean,
	question: string,
) {
	const [markdown, setMarkdown] = useState("");
	const [context, setContext] = useState<SearchDiscussionContext | null>(null);
	const [result, setResult] = useState<SearchDiscussionRunResult | null>(null);

	const onStart = useCallback(() => {
		setMarkdown("");
		setContext(null);
		setResult(null);
	}, []);
	const request = useCallback(
		(signal: AbortSignal, refresh: boolean) => {
			const trimmed = query.trim();
			return fetch(
				discussionUrl(trimmed, {
					source,
					mode,
					dateRange,
					includeDms,
					question,
					refresh,
				}),
				{ signal },
			);
		},
		[dateRange, includeDms, mode, query, question, source],
	);
	const onEvent = useCallback((event: SearchDiscussionStreamEvent) => {
		if (event.type === "start") setContext(event.context);
		else if (event.type === "delta") {
			setMarkdown((current) => current + event.delta);
		} else if (event.type === "done") {
			setResult(event.result);
			setContext(event.result.context);
			setMarkdown(event.result.markdown);
		} else if (event.type === "error") throw new Error(event.error);
	}, []);
	const {
		error,
		loading,
		run: runStream,
	} = useNdjsonRun({
		schema: searchDiscussionStreamEventSchema,
		request,
		onStart,
		onEvent,
		isTerminal: isTerminalStreamEvent,
		errorLabel: "Discussion request failed",
		emptyBodyMessage: "Discussion request failed: empty response body",
		prematureEofError: discussionPrematureEofError,
		formatError: discussionStreamError,
	});
	const run = useCallback(
		(refresh = false) => {
			if (query.trim()) runStream(refresh);
		},
		[query, runStream],
	);

	return { context, error, loading, markdown, result, run };
}

function DiscussRoute() {
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<DiscussRouteView
			searchState={search}
			onSearchChange={(next, options) =>
				void navigate({ search: next, replace: options?.replace })
			}
		/>
	);
}

export function DiscussRouteView({
	searchState: controlledSearch,
	onSearchChange,
}: {
	searchState?: DiscussRouteSearch;
	onSearchChange?: RouteSearchChange<DiscussRouteSearch>;
} = {}) {
	const [localSearch, setLocalSearch] = useState(() =>
		validateDiscussSearch({}),
	);
	const searchState = controlledSearch ?? localSearch;
	const updateSearch: RouteSearchChange<DiscussRouteSearch> = (next, options) =>
		onSearchChange ? onSearchChange(next, options) : setLocalSearch(next);
	const {
		q: query,
		question,
		source,
		mode,
		range,
		since,
		until,
		includeDms,
	} = searchState;
	const [queryDraft, setQueryDraft] = useState(query);
	const [questionDraft, setQuestionDraft] = useState(question);
	const [customRangeOpen, setCustomRangeOpen] = useState(
		() => range === "custom",
	);
	const queryComposingRef = useRef(false);
	const questionComposingRef = useRef(false);
	const [submittedSearch, setSubmittedSearch] = useState(() => ({
		query: "",
		dateRange: resolveDiscussDateRange("all"),
	}));
	const pendingSubmitRef = useRef(false);
	const { context, error, loading, markdown, result, run } =
		useDiscussionStream(
			submittedSearch.query,
			source,
			mode,
			submittedSearch.dateRange,
			includeDms,
			questionDraft,
		);
	const sourceLabel = useMemo(
		() => formatCounts(result?.context ?? context),
		[context, result],
	);
	const exportQuery = result?.context.query ?? submittedSearch.query;
	const [referencePdfActive, setReferencePdfActive] = useState(false);
	const canExportPdf = Boolean(markdown.trim()) && !loading;
	const canExportReferencePdf = Boolean(result) && !loading;
	const exportTitle = `BirdClaw ${exportQuery || "Discuss"} discussion`;
	const referenceExportTitle = `BirdClaw ${exportQuery || "Discuss"} discussion reference collection`;
	const exportUpdatedAt = result
		? new Date(result.updatedAt).toLocaleString(undefined, {
				dateStyle: "medium",
				timeStyle: "short",
			})
		: null;
	const referenceGroups = useMemo(
		() => (result ? collectDiscussionReferenceGroups(result, markdown) : []),
		[markdown, result],
	);
	const referenceDms = useMemo(
		() => (result ? collectDiscussionReferenceDms(result, markdown) : []),
		[markdown, result],
	);
	const referenceSourceCount = useMemo(
		() =>
			new Set(
				referenceGroups.flatMap((group) =>
					group.tweetIds.map(normalizeDiscussionReferenceId),
				),
			).size,
		[referenceGroups],
	);
	const handleExportPdf = useCallback(() => {
		if (!canExportPdf || referencePdfActive) return;
		exportCurrentPdf(exportTitle);
	}, [canExportPdf, exportTitle, referencePdfActive]);
	const handleExportReferencePdf = useCallback(() => {
		if (!canExportReferencePdf || !result || referencePdfActive) return;
		flushSync(() => setReferencePdfActive(true));
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
		void exportReferenceCollectionPdf({
			title: referenceExportTitle,
			sourceSelector: '[data-testid="discuss-reference-pdf"]',
			onCleanup: () => setReferencePdfActive(false),
		});
	}, [canExportReferencePdf, referenceExportTitle, referencePdfActive, result]);

	useEffect(() => {
		if (!queryComposingRef.current) setQueryDraft(query);
	}, [query]);

	useEffect(() => {
		if (!questionComposingRef.current) setQuestionDraft(question);
	}, [question]);

	useEffect(() => {
		setCustomRangeOpen(range === "custom");
	}, [range]);

	function changeQuery(value: string) {
		setQueryDraft(value);
		if (queryComposingRef.current) return;
		updateSearch({ ...searchState, q: value }, { replace: true });
	}

	function changeQuestion(value: string) {
		setQuestionDraft(value);
		if (questionComposingRef.current) return;
		updateSearch({ ...searchState, question: value }, { replace: true });
	}

	function submit(event: FormEvent) {
		event.preventDefault();
		const trimmed = queryDraft.trim();
		if (!trimmed) return;
		pendingSubmitRef.current = true;
		setSubmittedSearch({
			query: trimmed,
			dateRange: resolveDiscussDateRange(range, new Date(), { since, until }),
		});
	}

	useEffect(() => {
		if (!submittedSearch.query || !pendingSubmitRef.current) return;
		pendingSubmitRef.current = false;
		run(false);
	}, [run, submittedSearch]);

	return (
		<div className="today-pdf-root flex min-h-screen flex-col">
			<header className={cx("today-pdf-header", pageHeaderClass)}>
				<div className={pageHeaderRowClass}>
					<div className="min-w-0">
						<h1 className={pageTitleClass}>Discuss</h1>
						<p className={pageSubtitleClass}>{sourceLabel}</p>
					</div>
					<div className={cx("today-screen-only", pageHeaderActionsClass)}>
						<button
							type="button"
							className={secondaryButtonClass}
							onClick={handleExportPdf}
							disabled={!canExportPdf || referencePdfActive}
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
							导出完整 PDF
						</button>
						<button
							type="button"
							className={secondaryButtonClass}
							onClick={() => run(true)}
							disabled={loading || !submittedSearch.query || referencePdfActive}
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
					<span>Query: {result?.context.query ?? exportQuery}</span>
					<span>·</span>
					<span>Sources: {sourceLabel}</span>
					{exportUpdatedAt ? (
						<>
							<span>·</span>
							<span>Generated {exportUpdatedAt}</span>
						</>
					) : null}
				</div>
				<form
					className="today-screen-only grid gap-2 px-4 pb-3 md:grid-cols-[minmax(220px,1fr)_minmax(180px,0.8fr)_auto]"
					onSubmit={submit}
				>
					<label className={searchFieldShellClass}>
						<Search className={searchFieldIconClass} strokeWidth={2} />
						<input
							className={searchFieldInputClass}
							placeholder="Keywords"
							value={queryDraft}
							onCompositionStart={() => {
								queryComposingRef.current = true;
							}}
							onCompositionEnd={(event) => {
								queryComposingRef.current = false;
								changeQuery(event.currentTarget.value);
							}}
							onChange={(event) => changeQuery(event.currentTarget.value)}
						/>
					</label>
					<input
						className={textFieldClass}
						placeholder="Optional question"
						value={questionDraft}
						onCompositionStart={() => {
							questionComposingRef.current = true;
						}}
						onCompositionEnd={(event) => {
							questionComposingRef.current = false;
							changeQuestion(event.currentTarget.value);
						}}
						onChange={(event) => changeQuestion(event.currentTarget.value)}
					/>
					<button
						type="submit"
						className={primaryButtonClass}
						disabled={loading || !queryDraft.trim() || referencePdfActive}
					>
						<Sparkles className="size-4" aria-hidden="true" />
						Discuss
					</button>
					<div className="grid gap-2 md:col-span-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
						<DropdownField
							label="Source"
							options={sources}
							value={source}
							onChange={(value) =>
								updateSearch({ ...searchState, source: value })
							}
						/>
						<DropdownField
							label="Mode"
							options={modes}
							value={mode}
							onChange={(value) =>
								updateSearch({ ...searchState, mode: value })
							}
						/>
						<label className="inline-flex h-[54px] items-center gap-2 rounded-2xl border border-[var(--line)] bg-[var(--bg)] px-3 text-[13px] font-medium text-[var(--ink-soft)]">
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
					<div
						aria-label="Date range"
						className={cx(
							segmentedClass,
							"col-span-full w-fit max-w-full overflow-x-auto max-sm:grid max-sm:w-full max-sm:grid-cols-3 max-sm:overflow-visible max-sm:rounded-2xl",
						)}
						role="group"
					>
						{ranges.map((item) => (
							<button
								key={item.value}
								type="button"
								className={cx(
									segmentClass,
									"shrink-0",
									(item.value === "custom"
										? range === "custom" || customRangeOpen
										: !customRangeOpen && range === item.value) &&
										discussRangeSegmentActiveClass,
								)}
								onClick={() => {
									if (item.value === "custom") {
										setCustomRangeOpen((open) => !open);
										return;
									}
									setCustomRangeOpen(false);
									updateSearch({
										...searchState,
										range: item.value,
										since: "",
										until: "",
									});
								}}
							>
								{item.label}
							</button>
						))}
					</div>
					{customRangeOpen ? (
						<CustomDateRangePicker
							value={range === "custom" ? { since, until } : null}
							onApply={(customRange) =>
								updateSearch({
									...searchState,
									range: "custom",
									...customRange,
								})
							}
						/>
					) : null}
				</form>
			</header>

			{error ? <div className={errorCopyClass}>{error}</div> : null}

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
						? "Searching and streaming"
						: result
							? `${result.cached ? "Cached" : "Ready"} · ${result.context.query}`
							: "Ready"}
				</span>
			</div>

			{referencePdfActive && result ? (
				<ReferenceCollectionPrint
					coverTitle="BirdClaw Discuss 参考内容合集"
					documentTitle={result.discussion.title}
					documentSummary={result.discussion.summary}
					dms={referenceDms}
					groups={referenceGroups}
					insights={[
						{ title: "观点分歧", items: result.discussion.tensions },
						{ title: "后续关注", items: result.discussion.followUps },
					]}
					metadata={[
						`检索词：${result.context.query}`,
						...(result.context.question
							? [`讨论问题：${result.context.question}`]
							: []),
						`时间范围：${formatDiscussionRange(result.context)} · 数据源：${result.context.source}`,
						`生成日期：${formatDiscussionDate(result.updatedAt)} · 来源：${String(referenceSourceCount)} 条引用原文`,
					]}
					sectionLabels={{
						"Discussion themes": "热议主题",
						"Supplemental source list": "补充来源",
					}}
					sectionNotes={{
						"Discussion themes": "按讨论主题逐组阅读。",
						"Supplemental source list": "只作完整性补充。",
					}}
					testId="discuss-reference-pdf"
					tweets={result.context.tweets}
				/>
			) : null}

			{markdown ? (
				<MarkdownViewer
					className="today-digest-pdf"
					context={result?.context ?? context}
					markdownLinkClassName={discussMarkdownLinkClass}
					markdown={markdown}
					sourceOnlyCitations
				/>
			) : (
				<div className="px-4 py-5 text-[14px] text-[var(--ink-soft)]">
					{loading ? "Waiting for the first tokens..." : "Search to begin."}
				</div>
			)}
		</div>
	);
}
