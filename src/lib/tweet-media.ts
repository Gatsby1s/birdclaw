import type { TweetMediaItem } from "./types";

function isMp4Url(value: string) {
	try {
		const url = new URL(value, "http://birdclaw.local");
		return (
			(url.protocol === "http:" || url.protocol === "https:") &&
			/\.mp4$/i.test(url.pathname)
		);
	} catch {
		return false;
	}
}

export function playableTweetVideoUrl(item: TweetMediaItem) {
	if (item.type !== "video" && item.type !== "gif") return null;
	const variant = [...(item.variants ?? [])]
		.filter(
			(candidate) =>
				candidate.contentType === "video/mp4" || isMp4Url(candidate.url),
		)
		.sort(
			(left, right) => Number(right.bitRate ?? 0) - Number(left.bitRate ?? 0),
		)[0];
	if (variant) return variant.url;
	return isMp4Url(item.url) ? item.url : null;
}
