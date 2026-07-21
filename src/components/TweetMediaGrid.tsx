import { Maximize2, Play } from "lucide-react";
import { useState } from "react";
import { playableTweetVideoUrl } from "#/lib/tweet-media";
import type { TweetMediaItem } from "#/lib/types";
import { cx, tweetMediaGridClass, tweetMediaTileClass } from "#/lib/ui";
import {
	TweetMediaViewer,
	type TweetMediaViewerTweet,
} from "./TweetMediaViewer";

export function TweetMediaGrid({
	items,
	tweet,
}: {
	items: TweetMediaItem[];
	tweet?: TweetMediaViewerTweet;
}) {
	const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
	if (items.length === 0) {
		return null;
	}

	const visibleItems = items.slice(0, 4);
	const singleImage =
		visibleItems.length === 1 && visibleItems[0]?.type === "image"
			? visibleItems[0]
			: null;
	const singleVideoItem =
		visibleItems.length === 1 && visibleItems[0] ? visibleItems[0] : null;
	const singleVideoUrl = singleVideoItem
		? playableTweetVideoUrl(singleVideoItem)
		: null;

	return (
		<>
			{singleImage ? (
				<button
					aria-label="Open tweet media 1"
					className={cx(
						"tweet-media-single mt-2 max-w-full overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--bg-active)] p-0 text-left",
						singleImage.width && singleImage.height
							? "block"
							: "inline-block align-top",
					)}
					onClick={(event) => {
						event.stopPropagation();
						setSelectedIndex(0);
					}}
					onFocus={(event) => event.stopPropagation()}
					style={singleMediaStyle(singleImage)}
					type="button"
				>
					<img
						alt={singleImage.altText ?? "Tweet media 1"}
						className={cx(
							"tweet-media-image block max-h-[720px] max-w-full",
							singleImage.width && singleImage.height
								? "size-full object-cover"
								: "h-auto w-auto object-contain",
						)}
						height={singleImage.height}
						loading="lazy"
						src={singleImage.thumbnailUrl ?? singleImage.url}
						width={singleImage.width}
					/>
				</button>
			) : singleVideoItem && singleVideoUrl ? (
				<div
					className="tweet-media-single relative mt-2 max-w-full overflow-hidden rounded-2xl border border-[var(--line)] bg-black"
					style={
						singleMediaStyle(singleVideoItem) ?? {
							aspectRatio: "16 / 9",
							width: "100%",
						}
					}
				>
					{selectedIndex === null ? (
						<video
							aria-label={`${singleVideoItem.type === "gif" ? "Play tweet GIF" : "Play tweet video"} 1`}
							className="block size-full bg-black object-contain"
							controls
							loop={singleVideoItem.type === "gif"}
							muted={singleVideoItem.type === "gif"}
							onClick={(event) => event.stopPropagation()}
							onFocus={(event) => event.stopPropagation()}
							onPointerDown={(event) => event.stopPropagation()}
							playsInline
							poster={
								singleVideoItem.thumbnailUrl ??
								(singleVideoItem.url !== singleVideoUrl
									? singleVideoItem.url
									: undefined)
							}
							preload="none"
							src={singleVideoUrl}
						/>
					) : null}
					<button
						aria-label="Expand tweet media 1"
						className="absolute right-2 top-2 grid size-8 place-items-center rounded-full bg-black/65 text-white hover:bg-black/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
						onClick={(event) => {
							event.stopPropagation();
							setSelectedIndex(0);
						}}
						onFocus={(event) => event.stopPropagation()}
						type="button"
					>
						<Maximize2 className="size-4" strokeWidth={2} />
					</button>
				</div>
			) : (
				<div className={tweetMediaGridClass(Math.min(items.length, 4))}>
					{visibleItems.map((item, index) => {
						const style =
							visibleItems.length === 1 && item.width && item.height
								? {
										aspectRatio: `${String(item.width)} / ${String(item.height)}`,
									}
								: undefined;
						return (
							<button
								key={item.url + String(index)}
								aria-label={`Open tweet media ${String(index + 1)}`}
								className={tweetMediaTileClass(
									index,
									Math.min(items.length, 4),
								)}
								onClick={(event) => {
									event.stopPropagation();
									setSelectedIndex(index);
								}}
								onFocus={(event) => event.stopPropagation()}
								style={style}
								type="button"
							>
								{item.type === "image" ? (
									<img
										alt={item.altText ?? `Tweet media ${String(index + 1)}`}
										className="tweet-media-image block size-full object-contain"
										loading="lazy"
										src={item.thumbnailUrl ?? item.url}
									/>
								) : item.thumbnailUrl ? (
									<>
										<img
											alt=""
											className="block size-full object-contain"
											loading="lazy"
											src={item.thumbnailUrl}
										/>
										<span className="absolute inset-0 grid place-items-center bg-black/15 text-white">
											<span className="grid size-12 place-items-center rounded-full bg-black/65">
												<Play className="ml-0.5 size-5" fill="currentColor" />
											</span>
										</span>
									</>
								) : (
									<span className="tweet-media-fallback grid min-h-40 place-items-center font-semibold text-[var(--ink-soft)]">
										{item.type === "video"
											? "Video"
											: item.type === "gif"
												? "GIF"
												: "Media"}
									</span>
								)}
							</button>
						);
					})}
				</div>
			)}
			{selectedIndex !== null ? (
				<TweetMediaViewer
					initialIndex={selectedIndex}
					items={visibleItems}
					onClose={() => setSelectedIndex(null)}
					tweet={tweet}
				/>
			) : null}
		</>
	);
}

function singleMediaStyle(item: TweetMediaItem) {
	if (!item.width || !item.height) return undefined;
	const maxHeight = 720;
	const width = Math.min(
		item.width,
		Math.round((item.width / item.height) * maxHeight),
	);
	return {
		aspectRatio: `${String(item.width)} / ${String(item.height)}`,
		width: `${String(width)}px`,
	};
}
