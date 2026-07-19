import { createFileRoute } from "@tanstack/react-router";
import {
	ChevronDown,
	CheckCircle2,
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
import { MarkdownViewer } from "#/components/MarkdownViewer";
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
		<div className="flex min-h-screen flex-col">
			<header className={pageHeaderClass}>
				<div className={pageHeaderRowClass}>
					<div className="min-w-0">
						<h1 className={pageTitleClass}>Discuss</h1>
						<p className={pageSubtitleClass}>{sourceLabel}</p>
					</div>
					<div className={pageHeaderActionsClass}>
						<button
							type="button"
							className={secondaryButtonClass}
							onClick={() => run(true)}
							disabled={loading || !submittedSearch.query}
						>
							<RefreshCw
								className={cx("size-4", loading && "animate-spin")}
								aria-hidden="true"
							/>
							Refresh
						</button>
					</div>
				</div>
				<form
					className="grid gap-2 px-4 pb-3 md:grid-cols-[minmax(220px,1fr)_minmax(180px,0.8fr)_auto]"
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
						disabled={loading || !queryDraft.trim()}
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

			<div className="border-b border-[var(--line)] px-4 py-2 text-[13px] text-[var(--ink-soft)]">
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

			{markdown ? (
				<MarkdownViewer
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
