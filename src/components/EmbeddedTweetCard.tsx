import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { fetchJson } from "#/lib/api-client";
import { tweetTranslationResponseSchema } from "#/lib/api-contracts";
import { shouldAutoTranslateTweetText } from "#/lib/tweet-language";
import { rebaseTweetEntitiesForText } from "#/lib/tweet-render";
import { scheduleTimelineRequest } from "#/lib/timeline-request-scheduler";
import type { EmbeddedTweet } from "#/lib/types";
import {
	embeddedCardBodyClass,
	embeddedCardCopyClass,
	embeddedCardHandleClass,
	embeddedCardHeaderClass,
	embeddedCardLabelClass,
	embeddedCardNameClass,
	feedRowTimestampClass,
} from "#/lib/ui";
import { ProfilePreview } from "./ProfilePreview";
import { SmartTimestamp } from "./SmartTimestamp";
import { TweetArticleCard } from "./TweetArticleCard";
import { TweetMediaGrid } from "./TweetMediaGrid";
import { TweetRichText } from "./TweetRichText";
import { XRemarkAnnotationInline } from "./XRemarkAnnotation";

export function EmbeddedTweetCard({
	item,
	label,
	translationEnabled = false,
	translationSignal,
}: {
	item: EmbeddedTweet;
	label: string;
	translationEnabled?: boolean;
	translationSignal?: AbortSignal;
}) {
	const [showTranslation, setShowTranslation] = useState(true);
	const translationCandidate = shouldAutoTranslateTweetText(item.text);
	const translationQuery = useQuery({
		queryKey: ["tweet-translation", "zh-CN", item.id, item.text],
		queryFn: ({ signal }) =>
			scheduleTimelineRequest(
				(requestSignal) =>
					fetchJson(
						"/api/tweet-translation",
						{
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({
								tweetId: item.id,
								text: item.text,
								targetLanguage: "zh-CN",
							}),
							signal: requestSignal,
						},
						tweetTranslationResponseSchema,
						"Translation unavailable",
					),
				[signal, translationSignal],
			),
		enabled: translationEnabled && translationCandidate,
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});
	useEffect(() => {
		setShowTranslation(true);
	}, [item.id, item.text]);
	const availableTranslation =
		translationQuery.data?.translated === true ? translationQuery.data : null;
	const translatedText =
		showTranslation && availableTranslation
			? availableTranslation.translatedText
			: null;
	const translatedEntities = translatedText
		? rebaseTweetEntitiesForText(translatedText, item.entities)
		: null;

	return (
		<section className={embeddedCardBodyClass}>
			<p className={embeddedCardLabelClass}>{label}</p>
			<header className={embeddedCardHeaderClass}>
				<ProfilePreview profile={item.author}>
					<span className="flex min-w-0 items-center gap-1.5">
						<span className={embeddedCardNameClass}>
							{item.author.displayName}
						</span>
						<span className={embeddedCardHandleClass}>
							@{item.author.handle}
						</span>
					</span>
				</ProfilePreview>
				<span className="text-[var(--ink-soft)]">·</span>
				<SmartTimestamp
					className={feedRowTimestampClass}
					value={item.createdAt}
				/>
			</header>
			{item.author.xRemark ? (
				<XRemarkAnnotationInline annotation={item.author.xRemark} />
			) : null}
			<TweetRichText
				className={embeddedCardCopyClass}
				entities={translatedEntities ?? item.entities}
				text={translatedText ?? item.text}
			/>
			{translationEnabled && translationCandidate ? (
				<div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
					{availableTranslation ? (
						<>
							<span className="text-[12px] text-[var(--ink-soft)]">
								AI 翻译
							</span>
							<button
								aria-label={showTranslation ? "显示引用原文" : "显示引用翻译"}
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
						<span className="text-[12px] text-[var(--ink-soft)]" role="status">
							正在翻译…
						</span>
					) : translationQuery.isError ? (
						<button
							aria-label="重试引用翻译"
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
				</div>
			) : null}
			<TweetMediaGrid items={item.media} tweet={item} />
			{item.entities.article ? (
				<TweetArticleCard article={item.entities.article} />
			) : null}
		</section>
	);
}
