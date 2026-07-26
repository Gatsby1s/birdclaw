const ALLOWED_TWEET_VIDEO_PATH_PREFIXES = [
	"/amplify_video/",
	"/ext_tw_video/",
	"/tweet_video/",
] as const;

export function normalizeTweetVideoCdnUrl(value: string | null | undefined) {
	if (!value) return null;
	try {
		const url = new URL(value);
		if (
			url.protocol !== "https:" ||
			url.hostname !== "video.twimg.com" ||
			(url.port !== "" && url.port !== "443") ||
			url.username !== "" ||
			url.password !== "" ||
			!ALLOWED_TWEET_VIDEO_PATH_PREFIXES.some((prefix) =>
				url.pathname.startsWith(prefix),
			) ||
			!url.pathname.toLowerCase().endsWith(".mp4")
		) {
			return null;
		}
		return url.toString();
	} catch {
		return null;
	}
}

export function tweetVideoPlaybackUrl(value: string) {
	if (value.startsWith("/api/tweet-video?")) return value;
	const remoteUrl = normalizeTweetVideoCdnUrl(value);
	if (!remoteUrl) return value;
	const query = new URLSearchParams({ url: remoteUrl });
	return `/api/tweet-video?${query.toString()}`;
}
