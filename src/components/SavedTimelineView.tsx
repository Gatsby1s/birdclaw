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
	});

	const subtitle = useMemo(() => {
		if (!meta) {
			return items.length > 0
				? `${String(items.length)} visible`
				: loadingLabel;
		}
		return `${String(items.length)} visible · ${meta.transport.statusText}`;
	}, [items.length, loadingLabel, meta]);
	const syncKind = filter === "liked" ? "likes" : "bookmarks";

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
					action={
						<SyncNowButton
							accounts={meta?.accounts}
							kind={syncKind}
							label={filter === "liked" ? "Sync likes" : "Sync bookmarks"}
							onSynced={refreshLocalView}
						/>
					}
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
			emptyDetail="Sync this collection or broaden the search."
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
