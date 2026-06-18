import { Search } from "lucide-react";
import type { ReactNode } from "react";
import {
	FeedEmpty,
	FeedError,
	FeedLoading,
	TweetSkeletonRows,
} from "./FeedState";
import { ConversationSurfaceScope } from "#/lib/conversation-surface";
import {
	feedClass,
	pageHeaderClass,
	pageHeaderRowClass,
	pageSubtitleClass,
	pageTitleClass,
	searchFieldIconClass,
	searchFieldInputClass,
	searchFieldShellClass,
} from "#/lib/ui";

export function TimelineFeedHeader({
	title,
	subtitles,
	action,
	controls,
}: {
	title: string;
	subtitles: ReactNode;
	action?: ReactNode;
	controls?: ReactNode;
}) {
	return (
		<header className={pageHeaderClass}>
			<div className={pageHeaderRowClass}>
				<div className="flex min-w-0 flex-col">
					<h1 className={pageTitleClass}>{title}</h1>
					{subtitles}
				</div>
				{action}
			</div>
			{controls}
		</header>
	);
}

export function TimelineHeaderSubtitle({ children }: { children: ReactNode }) {
	return <p className={pageSubtitleClass}>{children}</p>;
}

export function TimelineSearchField({
	value,
	onChange,
	placeholder,
}: {
	value: string;
	onChange: (value: string) => void;
	placeholder: string;
}) {
	return (
		<div className="px-4 pb-3">
			<label className={searchFieldShellClass}>
				<Search className={searchFieldIconClass} strokeWidth={2} />
				<input
					className={searchFieldInputClass}
					onChange={(event) => onChange(event.target.value)}
					placeholder={placeholder}
					value={value}
				/>
			</label>
		</div>
	);
}

export function TimelineFeedShell({
	header,
	notice,
	loading,
	loadingLabel,
	loadingDetail,
	error,
	errorTitle,
	onRetry,
	empty,
	emptyLabel,
	emptyDetail,
	children,
	hasMore,
	loadingMore,
	onLoadMore,
}: {
	header: ReactNode;
	notice?: ReactNode;
	loading: boolean;
	loadingLabel: string;
	loadingDetail: string;
	error: string | null;
	errorTitle: string;
	onRetry: () => void;
	empty: boolean;
	emptyLabel: string;
	emptyDetail: string;
	children: ReactNode;
	hasMore: boolean;
	loadingMore: boolean;
	onLoadMore: () => void;
}) {
	return (
		<>
			{header}
			{notice}
			<ConversationSurfaceScope>
				<section className={feedClass}>
					{loading ? (
						<FeedLoading detail={loadingDetail} label={loadingLabel}>
							<TweetSkeletonRows />
						</FeedLoading>
					) : error ? (
						<FeedError
							action={
								<button
									className="rounded-full bg-[var(--accent)] px-4 py-1.5 text-[14px] font-bold text-white"
									onClick={onRetry}
									type="button"
								>
									Retry
								</button>
							}
							message={error}
							title={errorTitle}
						/>
					) : empty ? (
						<FeedEmpty detail={emptyDetail} label={emptyLabel} />
					) : null}
					{children}
					{!loading && !error && hasMore ? (
						<div className="flex justify-center py-4">
							<button
								className="rounded-full bg-[var(--accent)] px-5 py-1.5 text-[14px] font-bold text-white disabled:opacity-60"
								disabled={loadingMore}
								onClick={onLoadMore}
								type="button"
							>
								{loadingMore ? "Loading…" : "Load more"}
							</button>
						</div>
					) : null}
				</section>
			</ConversationSurfaceScope>
		</>
	);
}
