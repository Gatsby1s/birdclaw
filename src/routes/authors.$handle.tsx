import { createFileRoute } from "@tanstack/react-router";
import { ArrowLeft, ExternalLink, UserSearch } from "lucide-react";
import { useState } from "react";
import { AvatarChip } from "#/components/AvatarChip";
import { cleanProfileHandle } from "#/components/ProfileAnalysisStream";
import { ProfileRemarkEditor } from "#/components/ProfileRemarkEditor";
import { TimelineCard } from "#/components/TimelineCard";
import {
	TimelineFeedShell,
	TimelineSearchField,
} from "#/components/TimelineFeedShell";
import { useTimelineRouteData } from "#/components/useTimelineRouteData";
import { formatCompactNumber } from "#/lib/present";

export const Route = createFileRoute("/authors/$handle")({
	component: AuthorTimelineRoute,
});

const headerButtonClass =
	"inline-flex items-center justify-center gap-1.5 rounded-full border border-[var(--line-strong)] bg-[var(--bg)] px-4 py-1.5 text-[14px] font-bold text-[var(--ink)] shadow-sm transition-colors duration-150 hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]";

function stableHue(value: string) {
	let hash = 0;
	for (const char of value) {
		hash = (hash * 31 + char.charCodeAt(0)) % 360;
	}
	return hash;
}

function AuthorTimelineRoute() {
	const { handle } = Route.useParams();
	return <AuthorTimelineRouteView handle={handle} />;
}

export function AuthorTimelineRouteView({ handle }: { handle: string }) {
	const cleanHandle = cleanProfileHandle(handle);
	const [search, setSearch] = useState("");
	const {
		items,
		loading,
		error,
		retry,
		replyError,
		replyToTweet,
		selectedAccountId,
		hasMore,
		loadingMore,
		loadMore,
	} = useTimelineRouteData({
		resource: "home",
		author: cleanHandle,
		allAccounts: true,
		search,
		errorFallback: "Local profile timeline unavailable",
	});
	const profile = items.find(
		(item) => item.author.handle.toLowerCase() === cleanHandle.toLowerCase(),
	)?.author;
	const displayName = profile?.displayName || `@${cleanHandle}`;
	const visibleCount = `${String(items.length)}${hasMore ? "+" : ""}`;

	return (
		<TimelineFeedShell
			header={
				<>
					<header className="border-b border-[var(--line)] bg-[var(--bg)]">
						<div className="flex items-center gap-4 px-4 py-3">
							<a
								aria-label="Back to Home"
								className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-[var(--ink)] hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
								href="/"
							>
								<ArrowLeft className="size-5" strokeWidth={2} />
							</a>
							<div className="min-w-0">
								<h1 className="m-0 truncate text-[20px] font-bold text-[var(--ink)]">
									{displayName}
								</h1>
								<p className="m-0 text-[13px] text-[var(--ink-soft)]">
									{visibleCount} local posts loaded
								</p>
							</div>
						</div>
						<div
							className="h-28 bg-[linear-gradient(135deg,color-mix(in_srgb,var(--bg-active)_72%,var(--accent)_28%),color-mix(in_srgb,var(--bg)_76%,var(--accent)_24%))]"
							data-testid="author-cover"
						/>
						<div className="px-4 pb-4">
							<div className="-mt-8 flex items-start justify-between gap-3">
								<span className="inline-grid rounded-full ring-4 ring-[var(--bg)]">
									<AvatarChip
										avatarUrl={profile?.avatarUrl}
										hue={profile?.avatarHue ?? stableHue(cleanHandle)}
										name={displayName}
										profileId={profile?.id}
										size="large"
									/>
								</span>
								<div className="mt-10 flex shrink-0 items-center gap-2">
									<a
										className={headerButtonClass}
										href={`https://x.com/${encodeURIComponent(profile?.handle ?? cleanHandle)}`}
										rel="noreferrer"
										target="_blank"
									>
										<ExternalLink className="size-4" strokeWidth={1.8} />X
									</a>
									<a
										className={headerButtonClass}
										href={`/profiles/${encodeURIComponent(profile?.handle ?? cleanHandle)}`}
									>
										<UserSearch className="size-4" strokeWidth={1.8} />
										Analyse
									</a>
								</div>
							</div>
							<div className="mt-3 min-w-0">
								<h2 className="m-0 truncate text-[22px] font-bold text-[var(--ink)]">
									{displayName}
								</h2>
								<div className="truncate text-[14px] text-[var(--ink-soft)]">
									@{profile?.handle ?? cleanHandle}
								</div>
								{profile?.bio ? (
									<p className="mb-0 mt-3 max-w-2xl whitespace-pre-wrap text-[15px] leading-[1.45] text-[var(--ink)]">
										{profile.bio}
									</p>
								) : null}
								<ProfileRemarkEditor
									className="mt-3"
									handle={profile?.handle ?? cleanHandle}
									identifier={profile?.id}
									key={cleanHandle.toLowerCase()}
								/>
								{profile ? (
									<div className="mt-3 flex flex-wrap gap-4 text-[13px] text-[var(--ink-soft)]">
										<span>
											<strong className="text-[var(--ink)]">
												{formatCompactNumber(profile.followersCount)}
											</strong>{" "}
											followers
										</span>
										<span>
											<strong className="text-[var(--ink)]">
												{formatCompactNumber(profile.followingCount ?? 0)}
											</strong>{" "}
											following
										</span>
									</div>
								) : null}
							</div>
						</div>
						<div
							aria-label="Profile sections"
							className="grid grid-cols-2 border-t border-[var(--line)]"
							role="navigation"
						>
							<span
								aria-current="page"
								className="relative flex min-h-12 items-center justify-center px-4 text-[14px] font-bold text-[var(--ink)] after:absolute after:inset-x-6 after:bottom-0 after:h-1 after:rounded-full after:bg-[var(--accent)]"
							>
								Posts
							</span>
							<a
								className="flex min-h-12 items-center justify-center px-4 text-[14px] font-medium text-[var(--ink-soft)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink)]"
								href={`/profiles/${encodeURIComponent(profile?.handle ?? cleanHandle)}`}
							>
								Analysis
							</a>
						</div>
						<TimelineSearchField
							onChange={setSearch}
							placeholder={`Search @${cleanHandle}'s local posts`}
							value={search}
						/>
					</header>
				</>
			}
			notice={
				replyError ? (
					<p className="m-0 px-4 py-2 text-[13px] text-[var(--alert)]">
						{replyError}
					</p>
				) : null
			}
			loading={loading}
			loadingLabel={`Loading @${cleanHandle}`}
			loadingDetail="Reading this person’s locally stored posts"
			error={error}
			errorTitle="Could not load this local timeline"
			onRetry={retry}
			empty={items.length === 0}
			emptyLabel={`No local posts from @${cleanHandle}`}
			emptyDetail={
				search
					? "Try a different search."
					: "BirdClaw has not stored any posts from this person yet."
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
					bookmarkAccountId={selectedAccountId}
				/>
			))}
		</TimelineFeedShell>
	);
}
