import {
	Bookmark,
	BookmarkCheck,
	CheckCircle2,
	Circle,
	ExternalLink,
	Heart,
	Image,
	MessageCircle,
	Repeat2,
	UserSearch,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { fetchJson, setLocalBookmark } from "#/lib/api-client";
import {
	expandedTweetTextResponseSchema,
	tweetTranslationResponseSchema,
} from "#/lib/api-contracts";
import { formatCompactNumber } from "#/lib/present";
import { queryKeys } from "#/lib/query-client";
import { shouldAutoTranslateTweetText } from "#/lib/tweet-language";
import {
	isTweetArticleUrlEntity,
	normalizeTweetUrlEntityRangeForText,
	rebaseTweetEntitiesForText,
} from "#/lib/tweet-render";
import type {
	EmbeddedTweet,
	TimelineItem,
	TweetEntities,
	TweetMediaItem,
	TweetUrlEntity,
} from "#/lib/types";
import { useConversationSurface } from "#/lib/conversation-surface";
import {
	cx,
	embeddedCardClass,
	feedActionButtonClass,
	feedActionIconClass,
	feedActionIconWrapClass,
	feedRowActionsClass,
	feedRowBodyClass,
	feedRowClass,
	feedRowDotClass,
	feedRowHandleClass,
	feedRowHeaderClass,
	feedRowNameClass,
	feedRowStatePillActiveClass,
	feedRowStatePillClass,
	feedRowStatePillOpenClass,
	feedRowTextClass,
	feedRowTimestampClass,
} from "#/lib/ui";
import { AvatarChip } from "./AvatarChip";
import { ConversationThread } from "./ConversationThread";
import { EmbeddedTweetCard } from "./EmbeddedTweetCard";
import { LinkPreviewCard } from "./LinkPreviewCard";
import { ProfilePreview } from "./ProfilePreview";
import { SmartTimestamp } from "./SmartTimestamp";
import { TweetArticleCard } from "./TweetArticleCard";
import { TweetMediaGrid } from "./TweetMediaGrid";
import { TweetRichText } from "./TweetRichText";
import { XRemarkAnnotationCard } from "./XRemarkAnnotation";

function comparableUrl(value: string | null | undefined) {
	if (!value) return null;
	try {
		const parsed = new URL(value);
		return `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`;
	} catch {
		return value.split("?")[0] ?? value;
	}
}

function getMediaUrlSet(media: TweetMediaItem[]) {
	const urls = new Set<string>();
	for (const item of media) {
		for (const url of [item.url, item.thumbnailUrl]) {
			const comparable = comparableUrl(url);
			if (comparable) urls.add(comparable);
		}
	}
	return urls;
}

function isMediaUrlEntity(
	entry: TweetUrlEntity,
	mediaUrls: Set<string>,
	tweetId: string,
) {
	if (mediaUrls.size > 0 && isOwnStatusMediaUrl(entry.expandedUrl, tweetId)) {
		return true;
	}
	for (const url of [entry.url, entry.expandedUrl, entry.displayUrl]) {
		const comparable = comparableUrl(url);
		if (comparable && mediaUrls.has(comparable)) {
			return true;
		}
	}
	return false;
}

function isShortUrl(value: string | null | undefined) {
	if (!value) return false;
	try {
		const candidate = value.includes("://") ? value : `https://${value}`;
		const parsed = new URL(candidate);
		return parsed.hostname.replace(/^www\./, "") === "t.co";
	} catch {
		return false;
	}
}

function isUnresolvedShortUrlEntity(entry: TweetUrlEntity) {
	if (isShortUrl(entry.expandedUrl)) return true;
	if (entry.expandedUrl) return false;
	if (isShortUrl(entry.displayUrl)) return true;
	return !entry.displayUrl && isShortUrl(entry.url);
}

function unresolvedShortUrlRanges(text: string, entities: TweetEntities) {
	return (entities.urls ?? [])
		.filter(isUnresolvedShortUrlEntity)
		.map((entry) => normalizeTweetUrlEntityRangeForText(text, entry));
}

function textOutsideRanges(
	text: string,
	ranges: Array<{ start: number; end: number }>,
) {
	let cursor = 0;
	let output = "";
	for (const range of [...ranges].sort(
		(left, right) => left.start - right.start,
	)) {
		if (
			range.start < cursor ||
			range.end <= range.start ||
			range.end > text.length
		) {
			continue;
		}
		output += text.slice(cursor, range.start);
		cursor = range.end;
	}
	output += text.slice(cursor);
	return output;
}

function shouldHideUnresolvedShortUrls(
	text: string,
	entities: TweetEntities,
	mediaUrls: Set<string>,
) {
	if (mediaUrls.size === 0) return false;
	const ranges = unresolvedShortUrlRanges(text, entities);
	if (ranges.length === 0) return false;
	return textOutsideRanges(text, ranges).trim().length === 0;
}

function isOwnStatusMediaUrl(
	value: string | null | undefined,
	tweetId: string,
) {
	if (!value) return false;
	try {
		const parsed = new URL(value);
		const host = parsed.hostname.replace(/^www\./, "");
		if (host !== "x.com" && host !== "twitter.com") return false;
		const segments = parsed.pathname.split("/").filter(Boolean);
		const statusIndex = segments.indexOf("status");
		if (statusIndex < 0 || segments[statusIndex + 1] !== tweetId) {
			return false;
		}
		const mediaSegment = segments[statusIndex + 2];
		return mediaSegment === "photo" || mediaSegment === "video";
	} catch {
		return false;
	}
}

function getVisibleEntities(
	entities: TweetEntities,
	media: TweetMediaItem[],
	tweetId: string,
	text: string,
) {
	const mediaUrls = getMediaUrlSet(media);
	if (mediaUrls.size === 0) return entities;
	const hideUnresolvedShortUrls = shouldHideUnresolvedShortUrls(
		text,
		entities,
		mediaUrls,
	);
	return {
		...entities,
		urls: (entities.urls ?? []).filter(
			(entry) =>
				!isMediaUrlEntity(entry, mediaUrls, tweetId) &&
				!(hideUnresolvedShortUrls && isUnresolvedShortUrlEntity(entry)),
		),
	};
}

function getHiddenMediaUrlRanges(
	entities: TweetEntities,
	media: TweetMediaItem[],
	tweetId: string,
	text: string,
) {
	const mediaUrls = getMediaUrlSet(media);
	if (mediaUrls.size === 0) return [];
	const hideUnresolvedShortUrls = shouldHideUnresolvedShortUrls(
		text,
		entities,
		mediaUrls,
	);
	return (entities.urls ?? [])
		.filter(
			(entry) =>
				isMediaUrlEntity(entry, mediaUrls, tweetId) ||
				(hideUnresolvedShortUrls && isUnresolvedShortUrlEntity(entry)),
		)
		.map((entry) => normalizeTweetUrlEntityRangeForText(text, entry));
}

function getVisibleUrlCards(
	entities: TweetEntities,
	quotedTweetId: string | null,
) {
	return (entities.urls ?? []).filter((entry) => {
		if (isUnresolvedShortUrlEntity(entry)) return false;
		if (entities.article && isTweetArticleUrlEntity(entry, entities.article)) {
			return false;
		}
		if (!quotedTweetId) return true;
		return !entry.expandedUrl.includes(quotedTweetId);
	});
}

function isInteractiveTarget(target: EventTarget | null) {
	return (
		target instanceof Element &&
		Boolean(target.closest("a,button,input,textarea,select,[role='button']"))
	);
}

function tweetPermalink(handle: string | null | undefined, tweetId: string) {
	const cleanHandle = handle?.trim().replace(/^@/, "");
	if (!cleanHandle || !tweetId) return null;
	return `https://x.com/${encodeURIComponent(cleanHandle)}/status/${encodeURIComponent(tweetId)}`;
}

function likelyTruncatedText(text: string) {
	const value = text.trimEnd();
	return value.endsWith("…") || value.endsWith("...");
}

function useNearViewport() {
	const ref = useRef<HTMLElement | null>(null);
	const [nearViewport, setNearViewport] = useState(false);

	useEffect(() => {
		const node = ref.current;
		if (!node || nearViewport || typeof IntersectionObserver === "undefined") {
			return;
		}
		const observer = new IntersectionObserver(
			(entries) => {
				if (!entries.some((entry) => entry.isIntersecting)) return;
				setNearViewport(true);
				observer.disconnect();
			},
			{ rootMargin: "320px 0px" },
		);
		observer.observe(node);
		return () => observer.disconnect();
	}, [nearViewport]);

	return { nearViewport, ref };
}

function translatedHiddenUrlRanges(
	translatedText: string,
	originalText: string,
	hiddenUrlRanges: Array<{ start: number; end: number }>,
) {
	const ranges: Array<{ start: number; end: number }> = [];
	const usedStarts = new Set<number>();
	for (const originalRange of hiddenUrlRanges) {
		const hiddenValue = originalText.slice(
			originalRange.start,
			originalRange.end,
		);
		let searchFrom = 0;
		while (hiddenValue && searchFrom < translatedText.length) {
			const start = translatedText.indexOf(hiddenValue, searchFrom);
			if (start < 0) break;
			if (!usedStarts.has(start)) {
				usedStarts.add(start);
				ranges.push({ start, end: start + hiddenValue.length });
				break;
			}
			searchFrom = start + hiddenValue.length;
		}
	}
	return ranges;
}

function TweetPresentation({
	tweet,
	hiddenUrlRanges,
	visibleUrlCards,
	replyToTweet,
	quotedTweet,
	mediaViewerPermalink,
	translatedText,
	afterText,
}: {
	tweet: TimelineItem | EmbeddedTweet;
	hiddenUrlRanges: Array<{ start: number; end: number }>;
	visibleUrlCards: TweetUrlEntity[];
	replyToTweet?: EmbeddedTweet | null;
	quotedTweet?: EmbeddedTweet | null;
	mediaViewerPermalink?: string | null;
	translatedText?: string;
	afterText?: ReactNode;
}) {
	const translatedEntities = translatedText
		? rebaseTweetEntitiesForText(translatedText, tweet.entities)
		: null;
	const translatedHiddenRanges = translatedText
		? translatedHiddenUrlRanges(translatedText, tweet.text, hiddenUrlRanges)
		: [];
	return (
		<>
			{translatedText && translatedEntities ? (
				<TweetRichText
					className={feedRowTextClass}
					entities={translatedEntities}
					hiddenUrlRanges={translatedHiddenRanges}
					text={translatedText}
				/>
			) : (
				<TweetRichText
					className={feedRowTextClass}
					entities={tweet.entities}
					hiddenUrlRanges={hiddenUrlRanges}
					text={tweet.text}
				/>
			)}
			{afterText}
			<TweetMediaGrid
				items={tweet.media}
				tweet={{
					...tweet,
					hiddenUrlRanges,
					permalink: mediaViewerPermalink,
				}}
			/>
			{tweet.entities.article ? (
				<TweetArticleCard article={tweet.entities.article} />
			) : null}
			{replyToTweet ? (
				<div className={embeddedCardClass}>
					<EmbeddedTweetCard item={replyToTweet} label="In reply to" />
				</div>
			) : null}
			{quotedTweet ? (
				<div className={embeddedCardClass}>
					<EmbeddedTweetCard item={quotedTweet} label="Quoted tweet" />
				</div>
			) : null}
			{visibleUrlCards.map((entry, index) => (
				<LinkPreviewCard
					key={`${entry.expandedUrl}-${String(index)}`}
					entry={entry}
					index={index}
				/>
			))}
		</>
	);
}

export function TimelineCard({
	item,
	onReply,
	bookmarkAccountId,
	showReplyControls = true,
}: {
	item: TimelineItem;
	onReply: (tweetId: string) => void;
	bookmarkAccountId?: string;
	showReplyControls?: boolean;
}) {
	const [showFullRepost, setShowFullRepost] = useState(false);
	const [showTranslation, setShowTranslation] = useState(true);
	const translationViewport = useNearViewport();
	const canReply =
		showReplyControls && item.kind !== "like" && item.kind !== "bookmark";
	const displayTweet = item.retweetedTweet ?? item;
	const displayTweetId = displayTweet.id;
	const isManualRepostFallback =
		item.retweetedTweet != null && displayTweetId === `${item.id}:retweeted`;
	const canExpandRepost =
		isManualRepostFallback && likelyTruncatedText(displayTweet.text);
	const expandedRepostQuery = useQuery({
		queryKey: ["tweet-expand", item.id],
		queryFn: ({ signal }) => {
			const params = new URLSearchParams({ tweetId: item.id });
			return fetchJson(
				`/api/tweet-expand?${params.toString()}`,
				{ signal },
				expandedTweetTextResponseSchema,
				"Full repost unavailable",
			);
		},
		enabled: canExpandRepost && showFullRepost,
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});
	const expandedRepost = expandedRepostQuery.data;
	const presentedTweet =
		showFullRepost && expandedRepost
			? {
					...displayTweet,
					id: expandedRepost.sourceTweetId,
					text: expandedRepost.text,
				}
			: displayTweet;
	const translationCandidate = shouldAutoTranslateTweetText(
		presentedTweet.text,
	);
	const translationQuery = useQuery({
		queryKey: [
			"tweet-translation",
			"zh-CN",
			presentedTweet.id,
			presentedTweet.text,
		],
		queryFn: ({ signal }) =>
			fetchJson(
				"/api/tweet-translation",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						tweetId: presentedTweet.id,
						text: presentedTweet.text,
						targetLanguage: "zh-CN",
					}),
					signal,
				},
				tweetTranslationResponseSchema,
				"Translation unavailable",
			),
		enabled: translationViewport.nearViewport && translationCandidate,
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});
	useEffect(() => {
		setShowTranslation(true);
	}, [presentedTweet.id, presentedTweet.text]);
	const availableTranslation =
		translationQuery.data?.translated === true ? translationQuery.data : null;
	const translatedText =
		showTranslation && availableTranslation
			? availableTranslation.translatedText
			: undefined;
	const interactionTweetId =
		item.retweetedTweet && displayTweetId === `${item.id}:retweeted`
			? item.id
			: displayTweetId;
	const displayAuthor = displayTweet.author;
	const conversation = useConversationSurface(item.id, interactionTweetId);
	const visibleEntities = getVisibleEntities(
		presentedTweet.entities,
		presentedTweet.media,
		presentedTweet.id,
		presentedTweet.text,
	);
	const hiddenMediaUrlRanges = getHiddenMediaUrlRanges(
		presentedTweet.entities,
		presentedTweet.media,
		presentedTweet.id,
		presentedTweet.text,
	);
	const visibleUrlCards = getVisibleUrlCards(
		visibleEntities,
		item.retweetedTweet ? null : (item.quotedTweet?.id ?? null),
	);
	const displayMediaCount = item.retweetedTweet
		? (displayTweet.mediaCount ?? displayTweet.media.length)
		: item.mediaCount;
	const displayIsReplied = displayTweet.isReplied ?? item.isReplied;
	const displayLikeCount = displayTweet.likeCount ?? item.likeCount;
	const displayBookmarked = displayTweet.bookmarked ?? item.bookmarked;
	const displayLocalBookmarked =
		displayTweet.localBookmarked ?? item.localBookmarked ?? false;
	const displayLiked = displayTweet.liked ?? item.liked;
	const queryClient = useQueryClient();
	const [bookmarked, setBookmarked] = useState(displayLocalBookmarked);
	const bookmarkMutation = useMutation({
		mutationFn: (nextBookmarked: boolean) =>
			setLocalBookmark({
				accountId: bookmarkAccountId ?? item.accountId,
				tweetId: interactionTweetId,
				bookmarked: nextBookmarked,
			}),
		onMutate: (nextBookmarked) => {
			const previousBookmarked = bookmarked;
			setBookmarked(nextBookmarked);
			return { previousBookmarked };
		},
		onSuccess: () => {
			void Promise.all([
				queryClient.invalidateQueries({ queryKey: queryKeys.timelines }),
				queryClient.invalidateQueries({ queryKey: queryKeys.conversations }),
				queryClient.invalidateQueries({ queryKey: queryKeys.status }),
			]);
		},
		onError: (_error, _nextBookmarked, context) =>
			setBookmarked(context?.previousBookmarked ?? displayLocalBookmarked),
	});
	useEffect(() => {
		setBookmarked(displayLocalBookmarked);
	}, [displayLocalBookmarked]);
	const openTweetUrl = tweetPermalink(
		isManualRepostFallback && !expandedRepost
			? item.author.handle
			: displayAuthor.handle,
		isManualRepostFallback && !expandedRepost
			? item.id
			: (expandedRepost?.sourceTweetId ?? displayTweetId),
	);
	const showLikeIndicator = displayLiked || displayLikeCount > 0;
	const showMediaIndicator = displayMediaCount > 0;
	const hasConversation = Boolean(
		item.retweetedTweet
			? displayTweet.replyToId
			: item.replyToTweet || item.replyToId,
	);

	return (
		<article
			className={cx(
				feedRowClass,
				"cursor-pointer [content-visibility:auto] [contain-intrinsic-size:auto_280px]",
			)}
			data-perf="timeline-card"
			ref={translationViewport.ref}
			onFocus={conversation.prefetch}
			onMouseEnter={conversation.prefetch}
			onClick={(event) => {
				if (isInteractiveTarget(event.target)) return;
				conversation.toggle();
			}}
		>
			<a
				aria-label={`View @${displayAuthor.handle} local posts`}
				className="h-fit rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
				href={`/authors/${encodeURIComponent(displayAuthor.handle)}`}
				onClick={(event) => event.stopPropagation()}
			>
				<AvatarChip
					avatarUrl={displayAuthor.avatarUrl}
					hue={displayAuthor.avatarHue}
					name={displayAuthor.displayName}
					profileId={displayAuthor.id}
				/>
			</a>
			<div className={feedRowBodyClass}>
				{item.retweetedTweet ? (
					<div className="inline-flex items-center gap-2 text-[13px] font-medium text-[var(--ink-soft)]">
						<Repeat2 className="size-4" strokeWidth={1.8} />
						<ProfilePreview profile={item.author}>
							<span>{item.author.displayName} reposted</span>
						</ProfilePreview>
					</div>
				) : null}
				<header className={feedRowHeaderClass}>
					<ProfilePreview profile={displayAuthor}>
						<span className="flex min-w-0 items-center gap-1.5">
							<span className={feedRowNameClass}>
								{displayAuthor.displayName}
							</span>
							<span className={feedRowHandleClass}>
								@{displayAuthor.handle}
							</span>
						</span>
					</ProfilePreview>
					<span className={feedRowDotClass}>·</span>
					<SmartTimestamp
						className={feedRowTimestampClass}
						value={displayTweet.createdAt}
					/>
					{canReply || hasConversation ? (
						<span className="ml-auto inline-flex items-center gap-1">
							{hasConversation ? (
								<span
									aria-label="Part of a conversation"
									className={cx(
										feedRowStatePillClass,
										feedRowStatePillActiveClass,
									)}
									title="Part of a conversation"
								>
									<MessageCircle className="size-3.5" strokeWidth={2} />
									thread
								</span>
							) : null}
							{canReply ? (
								displayIsReplied || !openTweetUrl ? (
									<span
										aria-label={displayIsReplied ? "We replied" : "Reply open"}
										className={cx(
											feedRowStatePillClass,
											displayIsReplied
												? feedRowStatePillActiveClass
												: feedRowStatePillOpenClass,
										)}
										title={displayIsReplied ? "We replied" : "Reply open"}
									>
										{displayIsReplied ? (
											<CheckCircle2 className="size-3.5" strokeWidth={2} />
										) : (
											<Circle className="size-3" strokeWidth={2.2} />
										)}
										{displayIsReplied ? "replied" : "open"}
									</span>
								) : (
									<a
										aria-label="Reply open"
										className={cx(
											feedRowStatePillClass,
											feedRowStatePillOpenClass,
											"reply-open-pill cursor-pointer transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
										)}
										href={openTweetUrl}
										rel="noreferrer"
										target="_blank"
										title="Open original tweet"
									>
										<ExternalLink className="size-3.5" strokeWidth={2} />
										open
									</a>
								)
							) : null}
						</span>
					) : null}
				</header>
				{displayAuthor.xRemark ? (
					<XRemarkAnnotationCard
						annotation={displayAuthor.xRemark}
						className="mb-2"
						compact
					/>
				) : null}
				<TweetPresentation
					afterText={
						translationCandidate || canExpandRepost ? (
							<div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
								{availableTranslation ? (
									<>
										<span className="text-[12px] text-[var(--ink-soft)]">
											AI 翻译
										</span>
										<button
											aria-label={showTranslation ? "显示原文" : "显示翻译"}
											className="cursor-pointer border-0 bg-transparent p-0 text-[13px] font-semibold text-[var(--accent)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
											onClick={(event) => {
												event.stopPropagation();
												setShowTranslation((value) => !value);
											}}
											type="button"
										>
											{showTranslation ? "显示原文" : "显示翻译"}
										</button>
									</>
								) : translationQuery.isFetching ? (
									<span
										className="text-[12px] text-[var(--ink-soft)]"
										role="status"
									>
										正在翻译…
									</span>
								) : translationQuery.isError ? (
									<button
										aria-label="重试翻译"
										className="cursor-pointer border-0 bg-transparent p-0 text-[13px] font-semibold text-[var(--accent)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
										onClick={(event) => {
											event.stopPropagation();
											void translationQuery.refetch();
										}}
										type="button"
									>
										翻译暂不可用，重试
									</button>
								) : null}
								{canExpandRepost ? (
									<button
										aria-expanded={showFullRepost && Boolean(expandedRepost)}
										aria-label={
											showFullRepost && expandedRepost
												? "Collapse repost"
												: expandedRepostQuery.isError
													? "Retry full repost"
													: "Show full repost"
										}
										className="cursor-pointer border-0 bg-transparent p-0 text-[14px] font-semibold text-[var(--accent)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
										disabled={expandedRepostQuery.isFetching}
										onClick={(event) => {
											event.stopPropagation();
											if (showFullRepost && expandedRepost) {
												setShowFullRepost(false);
												return;
											}
											setShowFullRepost(true);
											if (expandedRepostQuery.isError) {
												void expandedRepostQuery.refetch();
											}
										}}
										type="button"
									>
										{expandedRepostQuery.isFetching
											? "Loading full post…"
											: showFullRepost && expandedRepost
												? "Show less"
												: expandedRepostQuery.isError
													? "Try again"
													: "Show more"}
									</button>
								) : null}
								{expandedRepostQuery.isError ? (
									<span
										className="text-[12px] text-[var(--alert)]"
										role="status"
									>
										Couldn’t load the full post.
									</span>
								) : null}
							</div>
						) : null
					}
					hiddenUrlRanges={hiddenMediaUrlRanges}
					mediaViewerPermalink={openTweetUrl}
					quotedTweet={item.retweetedTweet ? null : item.quotedTweet}
					replyToTweet={item.retweetedTweet ? null : item.replyToTweet}
					translatedText={translatedText}
					tweet={presentedTweet}
					visibleUrlCards={visibleUrlCards}
				/>
				<footer className={feedRowActionsClass}>
					<div className="flex items-center gap-3 text-[13px] text-[var(--ink-soft)]">
						<button
							aria-expanded={conversation.isOpen}
							aria-label={
								conversation.isOpen ? "Hide conversation" : "Show conversation"
							}
							className={feedActionButtonClass}
							onClick={(event) => {
								event.stopPropagation();
								conversation.toggle();
							}}
							type="button"
						>
							<span className={feedActionIconWrapClass}>
								<MessageCircle
									className={feedActionIconClass}
									strokeWidth={1.7}
								/>
							</span>
							<span className="text-[13px]">
								{conversation.isOpen ? "Hide thread" : "Thread"}
							</span>
						</button>
						{canReply ? (
							<button
								className={feedActionButtonClass}
								onClick={(event) => {
									event.stopPropagation();
									onReply(interactionTweetId);
								}}
								type="button"
								aria-label="Reply"
							>
								<span className={feedActionIconWrapClass}>
									<MessageCircle
										className={feedActionIconClass}
										strokeWidth={1.7}
									/>
								</span>
								<span className="text-[13px]">Reply</span>
							</button>
						) : null}
						<a
							aria-label={`Analyse @${displayAuthor.handle}`}
							className={feedActionButtonClass}
							href={`/profiles/${encodeURIComponent(displayAuthor.handle)}`}
							onClick={(event) => {
								event.stopPropagation();
							}}
							title={`Analyse @${displayAuthor.handle}`}
						>
							<span className={feedActionIconWrapClass}>
								<UserSearch className={feedActionIconClass} strokeWidth={1.7} />
							</span>
							<span className="text-[13px]">Analyse</span>
						</a>
						{showLikeIndicator ? (
							<span
								aria-label={`${formatCompactNumber(displayLikeCount)} likes`}
								className={cx(
									"inline-flex items-center gap-1 px-2 py-1 text-[13px]",
									displayLiked && "text-[var(--like)]",
								)}
								title={`${formatCompactNumber(displayLikeCount)} likes`}
							>
								<Heart
									className={feedActionIconClass}
									strokeWidth={1.7}
									fill={displayLiked ? "currentColor" : "none"}
								/>
								<span>{formatCompactNumber(displayLikeCount)}</span>
							</span>
						) : null}
						<button
							aria-label={
								bookmarked ? "Remove local bookmark" : "Bookmark locally"
							}
							aria-pressed={bookmarked}
							className={cx(
								feedActionButtonClass,
								bookmarked && "text-[var(--accent)]",
							)}
							disabled={bookmarkMutation.isPending}
							onClick={(event) => {
								event.stopPropagation();
								const nextBookmarked = !bookmarked;
								bookmarkMutation.mutate(nextBookmarked);
							}}
							title={
								bookmarked ? "Remove local bookmark" : "Save to local Bookmarks"
							}
							type="button"
						>
							<span className={feedActionIconWrapClass}>
								{bookmarked ? (
									<BookmarkCheck
										className={feedActionIconClass}
										strokeWidth={1.9}
									/>
								) : (
									<Bookmark className={feedActionIconClass} strokeWidth={1.7} />
								)}
							</span>
							<span className="text-[13px]">
								{bookmarked ? "Saved" : "Save"}
							</span>
						</button>
						{displayBookmarked ? (
							<span
								aria-label="Saved on X or in an imported archive"
								className="inline-flex items-center px-2 py-1 text-[var(--ink-soft)]"
								title="Saved on X or in an imported archive"
							>
								<BookmarkCheck
									className={feedActionIconClass}
									strokeWidth={1.7}
								/>
							</span>
						) : null}
						{showMediaIndicator ? (
							<span
								aria-label={`${String(displayMediaCount)} media attachments`}
								className="inline-flex items-center gap-1 px-2 py-1 text-[13px]"
								title={`${String(displayMediaCount)} media attachments`}
							>
								<Image className={feedActionIconClass} strokeWidth={1.7} />
								<span>{displayMediaCount}</span>
							</span>
						) : null}
					</div>
					{bookmarkMutation.isError ? (
						<span className="text-[12px] text-[var(--alert)]" role="status">
							Couldn’t update bookmark.
						</span>
					) : null}
				</footer>
				{conversation.isOpen ? (
					<ConversationThread
						anchorId={interactionTweetId}
						error={conversation.error}
						items={conversation.items}
						loading={conversation.loading}
					/>
				) : null}
			</div>
		</article>
	);
}
