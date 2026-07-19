import { useState } from "react";
import type { TweetMediaItem } from "#/lib/types";
import { cx, tweetMediaGridClass, tweetMediaTileClass } from "#/lib/ui";
import { TweetMediaViewer } from "./TweetMediaViewer";

export function TweetMediaGrid({ items }: { items: TweetMediaItem[] }) {
	const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
	if (items.length === 0) {
		return null;
	}

	const visibleItems = items.slice(0, 4);
	const singleImage =
		visibleItems.length === 1 && visibleItems[0]?.type === "image"
			? visibleItems[0]
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
					style={singleImageStyle(singleImage)}
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
			) : (
				<div className={tweetMediaGridClass(Math.min(items.length, 4))}>
					{visibleItems.map((item, index) => (
						<button
							key={item.url + String(index)}
							aria-label={`Open tweet media ${String(index + 1)}`}
							className={tweetMediaTileClass(index, Math.min(items.length, 4))}
							onClick={(event) => {
								event.stopPropagation();
								setSelectedIndex(index);
							}}
							onFocus={(event) => event.stopPropagation()}
							style={
								visibleItems.length === 1 && item.width && item.height
									? {
											aspectRatio: `${String(item.width)} / ${String(item.height)}`,
										}
									: undefined
							}
							type="button"
						>
							{item.type === "image" ? (
								<img
									alt={item.altText ?? `Tweet media ${String(index + 1)}`}
									className="tweet-media-image block size-full object-contain"
									loading="lazy"
									src={item.thumbnailUrl ?? item.url}
								/>
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
					))}
				</div>
			)}
			{selectedIndex !== null ? (
				<TweetMediaViewer
					initialIndex={selectedIndex}
					items={visibleItems}
					onClose={() => setSelectedIndex(null)}
				/>
			) : null}
		</>
	);
}

function singleImageStyle(item: TweetMediaItem) {
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
