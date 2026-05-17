import { Fragment } from "react";
import type { ReactNode } from "react";
import {
	collectTweetSegments,
	enrichFallbackUrlEntities,
} from "#/lib/tweet-render";
import type { TweetEntities } from "#/lib/types";
import {
	bodyCopyClass,
	tweetHashtagClass,
	tweetLinkClass,
	tweetMentionClass,
} from "#/lib/ui";
import { safeHttpUrl } from "#/lib/url-safety";
import { ProfilePreview } from "./ProfilePreview";

export function TweetRichText({
	text,
	entities,
	className = "body-copy",
	hiddenUrlRanges = [],
}: {
	text: string;
	entities: TweetEntities;
	className?: string;
	hiddenUrlRanges?: Array<{ start: number; end: number }>;
}) {
	const richEntities = enrichFallbackUrlEntities(text, entities);
	const segments = collectTweetSegments(richEntities);
	let cursor = 0;

	return (
		<p className={className === "body-copy" ? bodyCopyClass : className}>
			{segments.map((segment, index) => {
				if (
					segment.start < cursor ||
					segment.end <= segment.start ||
					segment.end > text.length
				) {
					return null;
				}

				const prefix = text.slice(cursor, segment.start);
				cursor = segment.end;

				let node: ReactNode = (
					<Fragment key={`segment-${String(index)}`}>
						{text.slice(segment.start, segment.end)}
					</Fragment>
				);
				if (
					segment.kind === "url" &&
					hiddenUrlRanges.some(
						(range) =>
							range.start === segment.start && range.end === segment.end,
					)
				) {
					node = null;
				} else if (segment.kind === "mention" && segment.profile) {
					node = (
						<ProfilePreview
							key={`segment-${String(index)}`}
							profile={segment.profile}
						>
							<span className={tweetMentionClass}>@{segment.username}</span>
						</ProfilePreview>
					);
				} else if (segment.kind === "url") {
					const href = safeHttpUrl(segment.expandedUrl);
					if (href) {
						node = (
							<a
								key={`segment-${String(index)}`}
								className={tweetLinkClass}
								href={href}
								rel="noreferrer"
								target="_blank"
							>
								{segment.displayUrl}
							</a>
						);
					}
				} else if (segment.kind === "hashtag") {
					node = (
						<span
							className={tweetHashtagClass}
							key={`segment-${String(index)}`}
						>
							#{segment.tag}
						</span>
					);
				}

				return (
					<Fragment key={`piece-${String(index)}`}>
						{prefix}
						{node}
					</Fragment>
				);
			})}
			{text.slice(cursor)}
		</p>
	);
}
