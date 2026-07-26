import { Maximize2, Play } from "lucide-react";
import { useRef, useState } from "react";
import { tweetVideoPlaybackUrl } from "#/lib/tweet-media";
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
	const [inlinePlaybackState, setInlinePlaybackState] = useState<
		"idle" | "playing" | "error"
	>("idle");
	const inlineVideoRef = useRef<HTMLVideoElement>(null);
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
		? tweetVideoPlaybackUrl(singleVideoItem)
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
						<>
							<video
								aria-label={`${singleVideoItem.type === "gif" ? "Tweet GIF" : "Tweet video"} 1`}
								className="block size-full bg-black object-contain"
								controls
								loop={singleVideoItem.type === "gif"}
								muted={singleVideoItem.type === "gif"}
								onClick={(event) => event.stopPropagation()}
								onError={() => setInlinePlaybackState("error")}
								onFocus={(event) => event.stopPropagation()}
								onPause={() => setInlinePlaybackState("idle")}
								onPlay={() => setInlinePlaybackState("playing")}
								onPointerDown={(event) => event.stopPropagation()}
								playsInline
								poster={
									singleVideoItem.thumbnailUrl ??
									(singleVideoItem.url !== singleVideoUrl
										? singleVideoItem.url
										: undefined)
								}
								preload="none"
								ref={inlineVideoRef}
								src={singleVideoUrl}
							/>
							{inlinePlaybackState !== "playing" ? (
								<button
									aria-label={`${singleVideoItem.type === "gif" ? "Play tweet GIF" : "Play tweet video"} 1`}
									className="absolute left-1/2 top-1/2 z-10 grid size-14 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-white/30 bg-black/70 text-white shadow-lg hover:bg-black/85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
									onClick={(event) => {
										event.stopPropagation();
										const video = inlineVideoRef.current;
										if (!video) return;
										setInlinePlaybackState("idle");
										try {
											void Promise.resolve(video.play())
												.then(() => setInlinePlaybackState("playing"))
												.catch(() => setInlinePlaybackState("error"));
										} catch {
											setInlinePlaybackState("error");
										}
									}}
									onPointerDown={(event) => event.stopPropagation()}
									type="button"
								>
									<Play className="ml-1 size-6" fill="currentColor" />
								</button>
							) : null}
							{inlinePlaybackState === "error" ? (
								<span
									className="pointer-events-none absolute bottom-12 left-1/2 z-10 -translate-x-1/2 rounded-full bg-black/75 px-3 py-1.5 text-center text-sm text-white"
									role="status"
								>
									Video unavailable
								</span>
							) : null}
						</>
					) : null}
					<button
						aria-label="Expand tweet media 1"
						className="absolute right-2 top-2 grid size-8 place-items-center rounded-full bg-black/65 text-white hover:bg-black/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
						onClick={(event) => {
							event.stopPropagation();
							setInlinePlaybackState("idle");
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
