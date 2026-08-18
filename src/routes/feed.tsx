import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
	Bolt,
	ChevronDown,
	ChevronUp,
	ExternalLink,
	LoaderCircle,
	Newspaper,
	RefreshCw,
} from "lucide-react";
import { useState } from "react";
import { FeedEmpty, FeedError, LinkSkeletonRows } from "#/components/FeedState";
import { SmartTimestamp } from "#/components/SmartTimestamp";
import {
	feedArticleContentResponseSchema,
	feedResponseSchema,
	type FeedItem,
	type FeedItemKind,
} from "#/lib/api-contracts";
import { type FeedRouteSearch, validateFeedSearch } from "#/lib/route-search";
import {
	cx,
	pageHeaderActionsClass,
	pageHeaderClass,
	pageHeaderRowClass,
	pageSubtitleClass,
	pageTitleClass,
	secondaryButtonClass,
	segmentClass,
	segmentedClass,
	segmentActiveClass,
} from "#/lib/ui";

export const Route = createFileRoute("/feed")({
	component: FeedRoute,
	validateSearch: validateFeedSearch,
});

function feedUrl(kind: FeedItemKind) {
	const url = new URL("/api/feed", window.location.origin);
	url.searchParams.set("kind", kind);
	url.searchParams.set("limit", "100");
	return url;
}

async function fetchFeed(kind: FeedItemKind) {
	const response = await fetch(feedUrl(kind), { cache: "no-store" });
	if (!response.ok)
		throw new Error(`Feed request failed: ${String(response.status)}`);
	return feedResponseSchema.parse(await response.json());
}

async function fetchArticleContent(itemId: string) {
	const url = new URL("/api/feed-article", window.location.origin);
	url.searchParams.set("id", itemId);
	const response = await fetch(url, { cache: "no-store" });
	if (!response.ok)
		throw new Error("Article content is temporarily unavailable");
	return feedArticleContentResponseSchema.parse(await response.json());
}

function symbolLabel(symbols: string[]) {
	if (symbols.length === 0) return null;
	const visible = symbols.slice(0, 4);
	return `${visible.join(" · ")}${symbols.length > visible.length ? ` +${String(symbols.length - visible.length)}` : ""}`;
}

export function FeedItemCard({ item }: { item: FeedItem }) {
	const Icon = item.kind === "flash" ? Bolt : Newspaper;
	const symbols = symbolLabel(item.symbols);
	const [expanded, setExpanded] = useState(false);
	const articleQuery = useQuery({
		queryKey: ["editorial-feed-article", item.id],
		queryFn: () => fetchArticleContent(item.id),
		enabled: item.kind === "article" && expanded,
		staleTime: Number.POSITIVE_INFINITY,
		retry: 1,
	});
	const contentRegionId = `feed-article-content-${item.externalId}`;
	return (
		<article className="border-b border-[var(--line)] px-4 py-4 last:border-b-0">
			<div className="flex min-w-0 gap-3">
				<div className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-[var(--bg-hover)] text-[var(--accent)]">
					<Icon className="size-4.5" aria-hidden="true" />
				</div>
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-[var(--ink-soft)]">
						{item.kind === "flash" ? (
							<span className="rounded-full bg-[color:color-mix(in_srgb,var(--alert)_12%,transparent)] px-2 py-0.5 font-bold text-[var(--alert)]">
								美股重要快讯
							</span>
						) : (
							<span className="rounded-full bg-[var(--bg-hover)] px-2 py-0.5 font-semibold">
								文章资讯
							</span>
						)}
						<span className="font-semibold text-[var(--ink)]">
							{item.publisher}
						</span>
						<span aria-hidden="true">·</span>
						<SmartTimestamp value={item.publishedAt} />
						{item.market ? (
							<>
								<span aria-hidden="true">·</span>
								<span className="uppercase">{item.market}</span>
							</>
						) : null}
					</div>
					<div className="mt-2">
						<h2 className="text-[15px] leading-[1.5] font-semibold text-[var(--ink)] [overflow-wrap:anywhere] group-hover:text-[var(--accent)]">
							{item.title}
						</h2>
						{item.summary ? (
							<p className="mt-1.5 line-clamp-3 text-[13px] leading-[1.55] text-[var(--ink-soft)] [overflow-wrap:anywhere]">
								{item.summary}
							</p>
						) : null}
					</div>
					{symbols ? (
						<div className="mt-2 text-[12px] font-medium text-[var(--ink-soft)]">
							{symbols}
						</div>
					) : null}
					{item.kind === "article" ? (
						<>
							<div className="mt-3 flex flex-wrap items-center gap-2">
								<button
									aria-controls={contentRegionId}
									aria-expanded={expanded}
									className={cx(secondaryButtonClass, "min-h-11")}
									onClick={() => setExpanded((value) => !value)}
									type="button"
								>
									{expanded ? (
										<ChevronUp className="size-4" aria-hidden="true" />
									) : (
										<ChevronDown className="size-4" aria-hidden="true" />
									)}
									{expanded ? "收起正文" : "阅读正文"}
								</button>
								<a
									className={cx(secondaryButtonClass, "min-h-11")}
									href={item.url}
									rel="noreferrer"
									target="_blank"
								>
									<ExternalLink className="size-4" aria-hidden="true" />
									打开老虎原文
								</a>
							</div>
							{expanded ? (
								<div
									className="mt-3 min-w-0 rounded-xl border border-[var(--line)] bg-[var(--bg-hover)] p-4"
									id={contentRegionId}
								>
									{articleQuery.isLoading ? (
										<div className="flex min-h-24 items-center justify-center gap-2 text-[13px] text-[var(--ink-soft)]">
											<LoaderCircle
												className="size-4 animate-spin"
												aria-hidden="true"
											/>
											正在读取正文…
										</div>
									) : articleQuery.data ? (
										<p className="whitespace-pre-wrap text-[14px] leading-7 text-[var(--ink)] [overflow-wrap:anywhere]">
											{articleQuery.data.content}
										</p>
									) : (
										<p className="text-[13px] leading-6 text-[var(--alert)]">
											正文暂时读取失败，可先打开老虎原文查看。
										</p>
									)}
								</div>
							) : null}
						</>
					) : (
						<a
							className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-lg text-[13px] font-semibold text-[var(--accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
							href={item.url}
							rel="noreferrer"
							target="_blank"
						>
							查看快讯来源
							<ExternalLink className="size-3.5" aria-hidden="true" />
						</a>
					)}
				</div>
			</div>
		</article>
	);
}

function statusCopy(data: Awaited<ReturnType<typeof fetchFeed>> | undefined) {
	if (!data) return "Tiger editorial feed";
	const lastSuccess = data.status.lastSuccessAt;
	if (data.status.state === "error") {
		return lastSuccess
			? `Showing saved items · last sync ${new Date(lastSuccess).toLocaleString()}`
			: "Tiger feed has not synced yet";
	}
	if (data.status.state === "syncing") return "Refreshing Tiger feed…";
	return lastSuccess
		? `Tiger · synced ${new Date(lastSuccess).toLocaleString()}`
		: "Tiger editorial feed";
}

function FeedRoute() {
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	const [syncing, setSyncing] = useState(false);
	const [syncError, setSyncError] = useState<string | null>(null);
	const query = useQuery({
		queryKey: ["editorial-feed", search.tab],
		queryFn: () => fetchFeed(search.tab),
		staleTime: search.tab === "flash" ? 30_000 : 2 * 60_000,
		refetchInterval: 60_000,
	});

	function selectTab(tab: FeedRouteSearch["tab"]) {
		if (tab === search.tab) return;
		void navigate({ search: { tab }, replace: true });
	}

	async function refresh() {
		setSyncing(true);
		setSyncError(null);
		try {
			const response = await fetch(`/api/feed-sync?kind=${search.tab}`, {
				method: "POST",
			});
			if (!response.ok) {
				throw new Error(`Feed refresh failed: ${String(response.status)}`);
			}
			await query.refetch();
		} catch (error) {
			setSyncError(
				error instanceof Error ? error.message : "Feed refresh failed",
			);
		} finally {
			setSyncing(false);
		}
	}

	const data = query.data;
	const error =
		syncError ?? (query.error instanceof Error ? query.error.message : null);
	return (
		<section className="flex min-h-screen min-w-0 flex-col">
			<header className={pageHeaderClass}>
				<div className={cx(pageHeaderRowClass, "flex-wrap")}>
					<div className="min-w-0">
						<h1 className={pageTitleClass}>Feed</h1>
						<p className={pageSubtitleClass}>{statusCopy(data)}</p>
					</div>
					<div className={pageHeaderActionsClass}>
						<button
							className={secondaryButtonClass}
							disabled={syncing}
							onClick={() => void refresh()}
							type="button"
						>
							<RefreshCw
								className={cx("size-4", syncing && "animate-spin")}
								aria-hidden="true"
							/>
							Refresh
						</button>
					</div>
				</div>
				<div className="mt-3">
					<div
						className={cx(segmentedClass, "grid w-full grid-cols-2 sm:w-auto")}
					>
						<button
							className={cx(
								segmentClass,
								"min-h-11",
								search.tab === "flash" && segmentActiveClass,
							)}
							onClick={() => selectTab("flash")}
							type="button"
						>
							美股快讯
						</button>
						<button
							className={cx(
								segmentClass,
								"min-h-11",
								search.tab === "article" && segmentActiveClass,
							)}
							onClick={() => selectTab("article")}
							type="button"
						>
							文章资讯
						</button>
					</div>
				</div>
			</header>

			{error ? (
				<FeedError
					action={
						<button
							className={secondaryButtonClass}
							onClick={() => void refresh()}
							type="button"
						>
							Retry
						</button>
					}
					message={error}
					title="Feed temporarily unavailable"
				/>
			) : query.isLoading ? (
				<LinkSkeletonRows count={6} />
			) : data?.items.length ? (
				<div>
					{data.items.map((item) => (
						<FeedItemCard item={item} key={item.id} />
					))}
				</div>
			) : (
				<FeedEmpty
					detail={
						search.tab === "flash"
							? "Only Tiger US-market items marked important appear here."
							: "Articles will appear after the next successful sync."
					}
					label={search.tab === "flash" ? "暂无美股重要快讯" : "暂无文章资讯"}
				/>
			)}
		</section>
	);
}
