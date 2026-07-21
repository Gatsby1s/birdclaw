import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TweetMediaGrid } from "./TweetMediaGrid";

const viewerTweet = {
	id: "tweet_detail",
	text: "Read the full post beside the image.",
	createdAt: "2026-03-08T12:00:00.000Z",
	likeCount: 42,
	liked: true,
	bookmarked: true,
	permalink: "https://x.com/viewer/status/tweet_detail",
	author: {
		id: "profile_viewer",
		handle: "viewer",
		displayName: "Viewer Author",
		bio: "bio",
		followersCount: 42,
		avatarHue: 210,
		createdAt: "2026-03-08T12:00:00.000Z",
	},
	entities: {},
};

describe("TweetMediaGrid", () => {
	afterEach(() => {
		cleanup();
	});

	it("renders nothing without media", () => {
		const { container } = render(<TweetMediaGrid items={[]} />);

		expect(container).toBeEmptyDOMElement();
	});

	it("renders images, fallback media labels, and caps the grid at four items", () => {
		const { container } = render(
			<TweetMediaGrid
				items={[
					{
						url: "https://example.com/one.jpg",
						type: "image",
						thumbnailUrl: "https://example.com/one-thumb.jpg",
					},
					{
						url: "https://example.com/two.mp4",
						type: "video",
					},
					{
						url: "https://example.com/three.gif",
						type: "gif",
					},
					{
						url: "https://example.com/four.bin",
						type: "unknown",
					},
					{
						url: "https://example.com/five.jpg",
						type: "image",
					},
				]}
			/>,
		);

		expect(container.firstChild).toHaveClass("tweet-media-grid-4");
		expect(screen.getByAltText("Tweet media 1")).toHaveAttribute(
			"src",
			"https://example.com/one-thumb.jpg",
		);
		expect(screen.getByText("Video")).toBeInTheDocument();
		expect(screen.getByText("GIF")).toBeInTheDocument();
		expect(screen.getByText("Media")).toBeInTheDocument();
		expect(
			screen.getAllByRole("button", { name: /Open tweet media/ }),
		).toHaveLength(4);
		expect(screen.queryByRole("link")).not.toBeInTheDocument();
	});

	it("opens images in an inline viewer", () => {
		render(
			<TweetMediaGrid
				items={[
					{
						url: "https://example.com/one.jpg",
						type: "image",
						width: 1200,
						height: 800,
					},
				]}
				tweet={viewerTweet}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Open tweet media 1" }));

		expect(
			screen.getByRole("dialog", { name: "Tweet media viewer" }),
		).toHaveClass("fixed", "inset-0", "bg-black");
		expect(screen.getByRole("img", { name: "Tweet media" })).toHaveAttribute(
			"src",
			"https://example.com/one.jpg",
		);
		expect(
			screen.getByRole("link", { name: "Open original media" }),
		).toHaveAttribute("href", "https://example.com/one.jpg");
		const details = document.querySelector('aside[aria-label="Tweet details"]');
		expect(details).toHaveTextContent("Viewer Author");
		expect(details).toHaveTextContent("@viewer");
		expect(details).toHaveTextContent("Read the full post beside the image.");
		expect(details).toHaveTextContent("42 Likes");
		expect(
			screen.getByRole("link", { name: "Open @viewer on X" }),
		).toHaveAttribute("href", "https://x.com/viewer/status/tweet_detail");
	});

	it("keeps the viewer media-only when no tweet context is supplied", () => {
		render(
			<TweetMediaGrid
				items={[{ url: "https://example.com/one.jpg", type: "image" }]}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Open tweet media 1" }));

		expect(
			document.querySelector('aside[aria-label="Tweet details"]'),
		).toBeNull();
	});

	it("zooms images from controls and direct image clicks", () => {
		render(
			<TweetMediaGrid
				items={[
					{
						url: "https://example.com/detail.jpg",
						type: "image",
					},
				]}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Open tweet media 1" }));

		const image = screen.getByRole("img", { name: "Tweet media" });
		expect(image).toHaveStyle({
			transform: "translate3d(0px, 0px, 0) scale(1)",
		});
		fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
		expect(screen.getByText("150%")).toBeInTheDocument();
		expect(image).toHaveStyle({
			transform: "translate3d(0px, 0px, 0) scale(1.5)",
		});

		fireEvent.click(image);
		expect(screen.getByText("100%")).toBeInTheDocument();
		fireEvent.click(image);
		expect(screen.getByText("200%")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Reset zoom" }));
		expect(screen.getByText("100%")).toBeInTheDocument();
	});

	it("navigates multi-image tweets with X-style arrows and the keyboard", () => {
		render(
			<TweetMediaGrid
				items={[
					{ url: "https://example.com/one.jpg", type: "image" },
					{ url: "https://example.com/two.jpg", type: "image" },
				]}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Open tweet media 1" }));
		expect(screen.getByText("1 / 2")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Next media" }));
		expect(screen.getByRole("img", { name: "Tweet media" })).toHaveAttribute(
			"src",
			"https://example.com/two.jpg",
		);
		expect(screen.getByText("2 / 2")).toBeInTheDocument();

		fireEvent.keyDown(window, { key: "ArrowLeft" });
		expect(screen.getByRole("img", { name: "Tweet media" })).toHaveAttribute(
			"src",
			"https://example.com/one.jpg",
		);
	});

	it("uses a natural single-image frame instead of the full grid shell", () => {
		const { container } = render(
			<TweetMediaGrid
				items={[
					{
						url: "https://example.com/tall.jpg",
						type: "image",
						altText: "Tall screenshot",
						width: 768,
						height: 1600,
					},
				]}
			/>,
		);

		expect(container.firstChild).toHaveClass("tweet-media-single");
		expect(container.firstChild).not.toHaveClass("tweet-media-grid");
		expect(screen.getByAltText("Tall screenshot")).toHaveAttribute(
			"width",
			"768",
		);
	});

	it("plays video media directly and keeps an expanded viewer", () => {
		render(
			<TweetMediaGrid
				items={[
					{
						url: "https://pbs.twimg.com/video-thumb.jpg",
						type: "video",
						thumbnailUrl: "https://pbs.twimg.com/video-thumb.jpg",
						variants: [
							{
								url: "https://video.twimg.com/clip-low.mp4",
								contentType: "video/mp4",
								bitRate: 256_000,
							},
							{
								url: "https://video.twimg.com/clip-high.mp4",
								contentType: "video/mp4",
								bitRate: 2_176_000,
							},
						],
					},
				]}
			/>,
		);

		const video = screen.getByLabelText("Play tweet video 1");
		expect(video).toHaveAttribute(
			"src",
			"https://video.twimg.com/clip-high.mp4",
		);
		expect(video).toHaveAttribute(
			"poster",
			"https://pbs.twimg.com/video-thumb.jpg",
		);
		expect(video).toHaveAttribute("controls");
		expect(video).toHaveAttribute("playsinline");
		expect(video).toHaveAttribute("preload", "none");
		expect(video).not.toHaveAttribute("autoplay");

		const expandButton = screen.getByRole("button", {
			name: "Expand tweet media 1",
		});
		expandButton.focus();
		fireEvent.click(expandButton);
		expect(
			screen.getByRole("dialog", { name: "Tweet media viewer" }),
		).toBeInTheDocument();
		expect(document.querySelectorAll("video")).toHaveLength(1);
		expect(
			screen.queryByLabelText("Play tweet video 1"),
		).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Close media viewer" }));
		expect(expandButton).toHaveFocus();
	});

	it("plays direct video CDN URLs without a variant", () => {
		render(
			<TweetMediaGrid
				items={[
					{
						url: "https://video.twimg.com/ext_tw_video/clip.mp4",
						type: "video",
					},
				]}
			/>,
		);

		expect(screen.getByLabelText("Play tweet video 1")).toHaveAttribute(
			"src",
			"https://video.twimg.com/ext_tw_video/clip.mp4",
		);
	});

	it("keeps gif mp4 fallbacks user-controlled until expanded", () => {
		render(
			<TweetMediaGrid
				items={[
					{
						url: "/media/demo.mp4",
						type: "gif",
					},
				]}
			/>,
		);

		const video = screen.getByLabelText("Play tweet GIF 1") as HTMLVideoElement;
		expect(video).toHaveAttribute("src", "/media/demo.mp4");
		expect(video).toHaveAttribute("loop");
		expect(video).toHaveAttribute("controls");
		expect(video).not.toHaveAttribute("autoplay");
		expect(video?.muted).toBe(true);
	});

	it("does not treat variant-less video thumbnails as playable video", () => {
		render(
			<TweetMediaGrid
				items={[
					{
						url: "https://pbs.twimg.com/ext_tw_video_thumb/video.jpg",
						type: "video",
						thumbnailUrl: "https://pbs.twimg.com/ext_tw_video_thumb/video.jpg",
					},
				]}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Open tweet media 1" }));

		expect(document.querySelector("video")).toBeNull();
		expect(screen.getByRole("link", { name: "Open media" })).toHaveAttribute(
			"href",
			"https://pbs.twimg.com/ext_tw_video_thumb/video.jpg",
		);
		expect(screen.getByRole("link", { name: "Open media" })).toHaveAttribute(
			"target",
			"_blank",
		);
	});

	it("closes the inline viewer from the close button", () => {
		render(
			<TweetMediaGrid
				items={[
					{
						url: "https://example.com/one.jpg",
						type: "image",
					},
				]}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Open tweet media 1" }));
		fireEvent.click(screen.getByRole("button", { name: "Close media viewer" }));

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("locks page scrolling and closes from Escape", () => {
		document.body.style.overflow = "auto";
		document.documentElement.style.scrollbarGutter = "stable";
		render(
			<TweetMediaGrid
				items={[
					{
						url: "https://example.com/one.jpg",
						type: "image",
					},
				]}
			/>,
		);

		const trigger = screen.getByRole("button", { name: "Open tweet media 1" });
		trigger.focus();
		fireEvent.click(trigger);
		expect(document.body.style.overflow).toBe("hidden");
		expect(document.documentElement.style.scrollbarGutter).toBe("auto");
		expect(
			screen.getByRole("dialog", { name: "Tweet media viewer" }),
		).toHaveFocus();
		fireEvent.keyDown(window, { key: "Escape" });

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(document.body.style.overflow).toBe("auto");
		expect(document.documentElement.style.scrollbarGutter).toBe("stable");
		expect(trigger).toHaveFocus();
		document.body.style.overflow = "";
		document.documentElement.style.scrollbarGutter = "";
	});

	it("keeps a fallback open path for unknown media", () => {
		render(
			<TweetMediaGrid
				items={[
					{
						url: "https://example.com/archive-media.bin",
						type: "unknown",
					},
				]}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Open tweet media 1" }));

		expect(screen.getByRole("dialog")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Open media" })).toHaveAttribute(
			"href",
			"https://example.com/archive-media.bin",
		);
		expect(screen.getByRole("link", { name: "Open media" })).toHaveAttribute(
			"rel",
			"noreferrer",
		);
	});
});
