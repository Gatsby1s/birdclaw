import type { TweetMediaItem } from "#/lib/types";
import { safeHttpUrl } from "#/lib/url-safety";

type ReferencePrintImage = {
	alt: string;
	fallbackSrc?: string;
	height?: number;
	src: string;
	width?: number;
};

export function ReferencePrintMedia({ items }: { items: TweetMediaItem[] }) {
	const images = referencePrintImages(items);
	if (images.length === 0) return null;

	const layout =
		images.length === 1
			? "single"
			: images.length === 2
				? "pair"
				: images.length <= 4
					? "grid"
					: "dense";

	return (
		<div
			className={`today-reference-media today-reference-media-${layout}`}
			data-reference-media-count={images.length}
		>
			{images.map((image) => (
				<figure key={image.src}>
					<img
						alt={image.alt}
						data-reference-fallback-src={image.fallbackSrc}
						decoding="sync"
						height={image.height}
						loading="eager"
						src={image.src}
						width={image.width}
					/>
				</figure>
			))}
		</div>
	);
}

function referencePrintImages(items: TweetMediaItem[]) {
	const seen = new Set<string>();
	return items.flatMap((item, index): ReferencePrintImage[] => {
		const candidate =
			item.type === "image"
				? (item.thumbnailUrl ?? item.url)
				: item.thumbnailUrl;
		const src = safeHttpUrl(candidate);
		if (!src || seen.has(src)) return [];
		seen.add(src);

		const fallbackSrc =
			item.type === "image" && item.thumbnailUrl !== undefined
				? safeHttpUrl(item.url)
				: null;
		const fallbackAlt =
			item.type === "image"
				? `推文图片 ${String(index + 1)}`
				: item.type === "video"
					? `推文视频封面 ${String(index + 1)}`
					: item.type === "gif"
						? `推文 GIF 封面 ${String(index + 1)}`
						: `推文媒体预览 ${String(index + 1)}`;

		return [
			{
				alt: item.altText?.trim() || fallbackAlt,
				fallbackSrc:
					fallbackSrc && fallbackSrc !== src ? fallbackSrc : undefined,
				height: item.height,
				src,
				width: item.width,
			},
		];
	});
}
