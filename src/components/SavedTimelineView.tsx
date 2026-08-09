import { Cloud } from "lucide-react";
import { useMemo, useState } from "react";
import { SyncNowButton } from "#/components/SyncNowButton";
import { TimelineCard } from "#/components/TimelineCard";
import {
	TimelineFeedHeader,
	TimelineFeedShell,
	TimelineHeaderSubtitle,
	TimelineSearchField,
} from "#/components/TimelineFeedShell";
import { useTimelineRouteData } from "#/components/useTimelineRouteData";

interface SavedTimelineViewProps {
	filter: "liked" | "bookmarked";
	eyebrow: string;
	title: string;
	loadingLabel: string;
	searchPlaceholder: string;
}

const TITLES: Record<SavedTimelineViewProps["filter"], string> = {
	liked: "Likes",
	bookmarked: "Bookmarks",
};

const BOOKMARK_AUTO_REFRESH_MS = 30_000;

export function SavedTimelineView({
	filter,
	title,
	loadingLabel,
	searchPlaceholder,
}: SavedTimelineViewProps) {
	const [search, setSearch] = useState("");
	const {
		meta,
		items,
		loading,
		error,
		retry,
		refreshLocalView,
		replyToTweet,
		hasMore,
		loadingMore,
		loadMore,
	} = useTimelineRouteData({
		resource: "home",
		search,
		errorFallback: `${TITLES[filter]} unavailable`,
		likedOnly: filter === "liked",
		bookmarkedOnly: filter === "bookmarked",
		refreshIntervalMs:
			filter === "bookmarked" ? BOOKMARK_AUTO_REFRESH_MS : undefined,
	});

	const subtitle = useMemo(() => {
		if (!meta) {
			return items.length > 0
				? `${String(items.length)} visible`
				: loadingLabel;
		}
		return `${String(items.length)} visible · ${meta.transport.statusText}`;
	}, [items.length, loadingLabel, meta]);
	const automaticBookmarkSync = meta?.bookmarkSyncMode === "automatic";
	const headerAction =
		filter === "liked" ? (
			<SyncNowButton
				accounts={meta?.accounts}
				kind="likes"
				label="Sync likes"
				onSynced={refreshLocalView}
			/>
		) : !meta ? null : automaticBookmarkSync ? (
			<div
				aria-label="Bookmarks sync automatically"
				className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-[color:color-mix(in_srgb,var(--accent)_35%,var(--line))] bg-[var(--accent-soft)] px-3 text-[13px] font-semibold text-[var(--accent)]"
				role="status"
			>
				<Cloud className="size-4" strokeWidth={2} />
				<span>Auto sync</span>
			</div>
		) : (
			<SyncNowButton
				accounts={meta.accounts}
				kind="bookmarks"
				label="Sync from X"
				onSynced={refreshLocalView}
			/>
		);

	return (
		<TimelineFeedShell
			header={
				<TimelineFeedHeader
					title={TITLES[filter]}
					subtitles={
						<>
							<TimelineHeaderSubtitle>{title}</TimelineHeaderSubtitle>
							<TimelineHeaderSubtitle>{subtitle}</TimelineHeaderSubtitle>
						</>
					}
					action={headerAction}
					controls={
						<TimelineSearchField
							onChange={setSearch}
							placeholder={searchPlaceholder}
							value={search}
						/>
					}
				/>
			}
			loading={loading}
			loadingLabel={loadingLabel}
			loadingDetail={`Reading local ${TITLES[filter].toLowerCase()}`}
			error={error}
			errorTitle={`Could not load ${TITLES[filter].toLowerCase()}`}
			onRetry={retry}
			empty={items.length === 0}
			emptyLabel="Nothing saved here yet"
			emptyDetail={
				filter === "bookmarked"
					? automaticBookmarkSync
						? "Bookmarks appear here automatically as they sync."
						: "Use Sync from X to collect bookmarks into this local view."
					: "Sync this collection or broaden the search."
			}
			hasMore={hasMore}
			loadingMore={loadingMore}
			onLoadMore={loadMore}
		>
			{items.map((item) => (
				<TimelineCard
					key={item.id}
					item={item}
					onReply={replyToTweet}
					showReplyControls={false}
				/>
			))}
		</TimelineFeedShell>
	);
}
