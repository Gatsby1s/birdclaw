import { useMemo, useState } from "react";
import { SyncNowButton } from "#/components/SyncNowButton";
import { TimelineCard } from "#/components/TimelineCard";
import {
	TimelineFeedHeader,
	TimelineFeedShell,
	TimelineHeaderSubtitle,
	TimelineSearchField,
} from "#/components/TimelineFeedShell";
import type { QueryEnvelope } from "#/lib/api-contracts";
import type { ReplyFilter } from "#/lib/types";
import type { WebSyncKind } from "#/lib/web-sync";
import {
	cx,
	tabButtonActiveClass,
	tabButtonClass,
	tabButtonIndicatorClass,
	tabStripClass,
	timestampClass,
} from "#/lib/ui";
import { useTimelineRouteData } from "./useTimelineRouteData";

const TABS: Array<{ value: ReplyFilter; label: string }> = [
	{ value: "all", label: "All" },
	{ value: "unreplied", label: "Unreplied" },
	{ value: "replied", label: "Replied" },
];

interface TimelineRouteFrameProps {
	title: string;
	resource: "home" | "mentions";
	initialReplyFilter: ReplyFilter;
	searchPlaceholder: string;
	syncKind: WebSyncKind;
	syncLabel: string;
	loadingLabel: string;
	loadingDetail: string;
	errorTitle: string;
	errorFallback: string;
	emptyLabel: string;
	emptyDetail: string;
	subtitle: (meta: QueryEnvelope | null) => string;
	showAutoRefreshControl?: boolean;
	showRepliesToOthersControl?: boolean;
	initialIncludeRepliesToOthers?: boolean;
}

export function TimelineRouteFrame({
	title,
	resource,
	initialReplyFilter,
	searchPlaceholder,
	syncKind,
	syncLabel,
	loadingLabel,
	loadingDetail,
	errorTitle,
	errorFallback,
	emptyLabel,
	emptyDetail,
	subtitle,
	showAutoRefreshControl = false,
	showRepliesToOthersControl = false,
	initialIncludeRepliesToOthers = true,
}: TimelineRouteFrameProps) {
	const [replyFilter, setReplyFilter] =
		useState<ReplyFilter>(initialReplyFilter);
	const [search, setSearch] = useState("");
	const [includeRepliesToOthers, setIncludeRepliesToOthers] = useState(
		initialIncludeRepliesToOthers,
	);
	const {
		meta,
		items,
		loading,
		error,
		replyError,
		retry,
		refreshLocalView,
		replyToTweet,
		hasMore,
		loadingMore,
		loadMore,
	} = useTimelineRouteData({
		resource,
		replyFilter,
		search,
		errorFallback,
		includeRepliesToOthers,
	});
	const subtitleText = useMemo(() => subtitle(meta), [meta, subtitle]);
	const repliesToOthersControl = showRepliesToOthersControl ? (
		<label className="inline-flex items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-[13px] font-medium text-[var(--ink-soft)] shadow-sm">
			<input
				checked={includeRepliesToOthers}
				className="size-4 rounded border-[var(--line)] accent-[var(--accent)]"
				onChange={(event) =>
					setIncludeRepliesToOthers(event.currentTarget.checked)
				}
				type="checkbox"
			/>
			<span>Replies to others</span>
		</label>
	) : null;

	return (
		<TimelineFeedShell
			header={
				<TimelineFeedHeader
					title={title}
					subtitles={
						<TimelineHeaderSubtitle>{subtitleText}</TimelineHeaderSubtitle>
					}
					action={
						<div className="flex flex-wrap items-center justify-end gap-3">
							{repliesToOthersControl}
							<SyncNowButton
								accounts={meta?.accounts}
								kind={syncKind}
								label={syncLabel}
								onSynced={refreshLocalView}
								showAutoRefreshControls={showAutoRefreshControl}
								showAccountPicker
							/>
						</div>
					}
					controls={
						<>
							<TimelineSearchField
								onChange={setSearch}
								placeholder={searchPlaceholder}
								value={search}
							/>
							<div className={tabStripClass}>
								{TABS.map((tab) => {
									const active = replyFilter === tab.value;
									return (
										<button
											key={tab.value}
											type="button"
											aria-pressed={active}
											className={cx(
												tabButtonClass,
												active && tabButtonActiveClass,
											)}
											onClick={() => setReplyFilter(tab.value)}
										>
											<span className="relative inline-flex flex-col items-center justify-center py-1">
												{tab.label}
												{active ? (
													<span className={tabButtonIndicatorClass} />
												) : null}
											</span>
										</button>
									);
								})}
							</div>
						</>
					}
				/>
			}
			notice={
				replyError ? (
					<p className={cx(timestampClass, "px-4 py-2 text-red-500")}>
						{replyError}
					</p>
				) : null
			}
			loading={loading}
			loadingLabel={loadingLabel}
			loadingDetail={loadingDetail}
			error={error}
			errorTitle={errorTitle}
			onRetry={retry}
			empty={items.length === 0}
			emptyLabel={emptyLabel}
			emptyDetail={emptyDetail}
			hasMore={hasMore}
			loadingMore={loadingMore}
			onLoadMore={loadMore}
		>
			{items.map((item) => (
				<TimelineCard key={item.id} item={item} onReply={replyToTweet} />
			))}
		</TimelineFeedShell>
	);
}
