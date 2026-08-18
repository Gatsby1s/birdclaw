import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Bolt, ExternalLink, Newspaper, RefreshCw } from "lucide-react";
import { useState } from "react";
import { FeedEmpty, FeedError, LinkSkeletonRows } from "#/components/FeedState";
import { SmartTimestamp } from "#/components/SmartTimestamp";
import {
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

function symbolLabel(symbols: string[]) {
	if (symbols.length === 0) return null;
	const visible = symbols.slice(0, 4);
	return `${visible.join(" · ")}${symbols.length > visible.length ? ` +${String(symbols.length - visible.length)}` : ""}`;
}

function FeedItemCard({ item }: { item: FeedItem }) {
	const Icon = item.kind === "flash" ? Bolt : Newspaper;
	const symbols = symbolLabel(item.symbols);
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
								重要快讯
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
					<a
						className="group mt-2 block rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
						href={item.url}
						rel="noreferrer"
						target="_blank"
					>
						<h2 className="text-[15px] leading-[1.5] font-semibold text-[var(--ink)] [overflow-wrap:anywhere] group-hover:text-[var(--accent)]">
							{item.title}
							<ExternalLink className="ml-1 inline size-3.5 align-[-2px] opacity-60" />
						</h2>
						{item.summary ? (
							<p className="mt-1.5 line-clamp-3 text-[13px] leading-[1.55] text-[var(--ink-soft)] [overflow-wrap:anywhere]">
								{item.summary}
							</p>
						) : null}
					</a>
					{symbols ? (
						<div className="mt-2 text-[12px] font-medium text-[var(--ink-soft)]">
							{symbols}
						</div>
					) : null}
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
							快讯
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
							? "Only Tiger items marked important appear here."
							: "Articles will appear after the next successful sync."
					}
					label={search.tab === "flash" ? "暂无重要快讯" : "暂无文章资讯"}
				/>
			)}
		</section>
	);
}
