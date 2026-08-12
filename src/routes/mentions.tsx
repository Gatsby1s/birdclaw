import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { SpecialFollowTimeline } from "#/components/SpecialFollowTimeline";
import { TimelineRouteFrame } from "#/components/TimelineRouteFrame";
import type { QueryEnvelope } from "#/lib/api-contracts";
import {
	cx,
	tabButtonActiveClass,
	tabButtonClass,
	tabButtonIndicatorClass,
	tabStripClass,
} from "#/lib/ui";

export const Route = createFileRoute("/mentions")({
	component: MentionsRoute,
});

function mentionsSubtitle(meta: QueryEnvelope | null) {
	if (!meta) return "Loading mentions...";
	return `${String(meta.stats.mentions)} mention/reply items in local store`;
}

function MentionsRoute() {
	const [view, setView] = useState<"mentions" | "special-follow">("mentions");
	const viewTabs = (
		<nav aria-label="Mentions views" className={tabStripClass}>
			{(
				[
					["mentions", "提及"],
					["special-follow", "特别关注"],
				] as const
			).map(([value, label]) => {
				const active = view === value;
				return (
					<button
						key={value}
						aria-pressed={active}
						className={cx(tabButtonClass, active && tabButtonActiveClass)}
						onClick={() => setView(value)}
						type="button"
					>
						<span className="relative inline-flex flex-col items-center justify-center py-1">
							{label}
							{active ? <span className={tabButtonIndicatorClass} /> : null}
						</span>
					</button>
				);
			})}
		</nav>
	);

	if (view === "special-follow") {
		return <SpecialFollowTimeline viewTabs={viewTabs} />;
	}

	return (
		<TimelineRouteFrame
			emptyDetail="Try All, search less narrowly, or sync mentions."
			emptyLabel="No mentions in this view"
			errorFallback="Mentions unavailable"
			errorTitle="Could not load mentions"
			initialReplyFilter="unreplied"
			loadingDetail="Checking local mentions and reply context"
			loadingLabel="Loading mentions"
			resource="mentions"
			searchPlaceholder="Search mentions"
			subtitle={mentionsSubtitle}
			syncKind="mentions"
			syncLabel="Sync mentions"
			title="Mentions"
			viewTabs={viewTabs}
		/>
	);
}
