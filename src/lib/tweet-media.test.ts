import { describe, expect, it } from "vitest";
import { playableTweetVideoUrl, tweetVideoPlaybackUrl } from "./tweet-media";

describe("tweet video playback URLs", () => {
	it("selects the highest bitrate MP4 and routes Twitter CDN playback locally", () => {
		const item = {
			url: "https://pbs.twimg.com/ext_tw_video_thumb/poster.jpg",
			type: "video" as const,
			variants: [
				{
					url: "https://video.twimg.com/ext_tw_video/low.mp4",
					contentType: "video/mp4",
					bitRate: 256_000,
				},
				{
					url: "https://video.twimg.com/ext_tw_video/high.mp4?tag=29",
					contentType: "video/mp4",
					bitRate: 2_176_000,
				},
			],
		};

		expect(playableTweetVideoUrl(item)).toBe(
			"https://video.twimg.com/ext_tw_video/high.mp4?tag=29",
		);
		const playbackUrl = tweetVideoPlaybackUrl(item);
		expect(playbackUrl).toBe(
			"/api/tweet-video?url=https%3A%2F%2Fvideo.twimg.com%2Fext_tw_video%2Fhigh.mp4%3Ftag%3D29",
		);
		expect(
			new URL(playbackUrl as string, "http://birdclaw.local").searchParams.get(
				"url",
			),
		).toBe("https://video.twimg.com/ext_tw_video/high.mp4?tag=29");
	});

	it("keeps local and non-Twitter MP4 sources unchanged", () => {
		expect(tweetVideoPlaybackUrl({ url: "/media/demo.mp4", type: "gif" })).toBe(
			"/media/demo.mp4",
		);
		expect(
			tweetVideoPlaybackUrl({
				url: "https://cdn.example.com/archive/demo.mp4",
				type: "video",
			}),
		).toBe("https://cdn.example.com/archive/demo.mp4");
	});

	it("does not treat HLS, images, or non-video media as playable MP4", () => {
		expect(
			tweetVideoPlaybackUrl({
				url: "https://pbs.twimg.com/video-thumb.jpg",
				type: "video",
				variants: [
					{
						url: "https://video.twimg.com/ext_tw_video/playlist.m3u8",
						contentType: "application/x-mpegURL",
					},
				],
			}),
		).toBeNull();
		expect(
			tweetVideoPlaybackUrl({
				url: "https://pbs.twimg.com/media/photo.jpg",
				type: "image",
			}),
		).toBeNull();
	});
});
