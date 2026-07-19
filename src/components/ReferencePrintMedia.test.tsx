import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { TweetMediaItem } from "#/lib/types";
import { ReferencePrintMedia } from "./ReferencePrintMedia";

function image(index: number): TweetMediaItem {
	return {
		height: 800 + index,
		type: "image",
		url: `https://example.com/image-${String(index)}.jpg`,
		width: 1200 + index,
	};
}

describe("ReferencePrintMedia", () => {
	afterEach(() => {
		cleanup();
	});

	it("renders nothing without printable media", () => {
		const { container, rerender } = render(<ReferencePrintMedia items={[]} />);

		expect(container).toBeEmptyDOMElement();

		rerender(
			<ReferencePrintMedia
				items={[
					{ type: "video", url: "https://example.com/video.mp4" },
					{ type: "gif", url: "https://example.com/animation.mp4" },
					{ type: "unknown", url: "https://example.com/media.bin" },
				]}
			/>,
		);

		expect(container).toBeEmptyDOMElement();
	});

	it.each([
		{ count: 1, layout: "single" },
		{ count: 2, layout: "pair" },
		{ count: 3, layout: "grid" },
		{ count: 4, layout: "grid" },
		{ count: 5, layout: "dense" },
	])(
		"uses the $layout layout for $count printable items",
		({ count, layout }) => {
			const { container } = render(
				<ReferencePrintMedia
					items={Array.from({ length: count }, (_, index) => image(index + 1))}
				/>,
			);

			const media = container.firstChild;
			expect(media).toHaveClass("today-reference-media");
			expect(media).toHaveClass(`today-reference-media-${layout}`);
			expect(media).toHaveAttribute(
				"data-reference-media-count",
				String(count),
			);
			expect(screen.getAllByRole("img")).toHaveLength(count);
		},
	);

	it("renders every image source without capping dense print layouts", () => {
		const items = Array.from({ length: 7 }, (_, index) => image(index + 1));
		render(<ReferencePrintMedia items={items} />);

		const images = screen.getAllByRole("img");
		expect(images).toHaveLength(7);
		for (const [index, renderedImage] of images.entries()) {
			const source = items[index];
			expect(renderedImage).toHaveAttribute("src", source?.url);
		}
	});

	it("includes thumbnail previews for non-image media and uses accessible Chinese labels", () => {
		render(
			<ReferencePrintMedia
				items={[
					{
						height: 900,
						thumbnailUrl: "https://example.com/image-thumb.jpg",
						type: "image",
						url: "https://example.com/image.jpg",
						width: 1600,
					},
					{
						thumbnailUrl: "https://example.com/video-cover.jpg",
						type: "video",
						url: "https://example.com/video.mp4",
					},
					{
						thumbnailUrl: "https://example.com/gif-cover.jpg",
						type: "gif",
						url: "https://example.com/animation.mp4",
					},
					{
						thumbnailUrl: "https://example.com/media-cover.jpg",
						type: "unknown",
						url: "https://example.com/media.bin",
					},
				]}
			/>,
		);

		expect(screen.getByRole("img", { name: "推文图片 1" })).toHaveAttribute(
			"src",
			"https://example.com/image.jpg",
		);
		expect(screen.getByRole("img", { name: "推文图片 1" })).toHaveAttribute(
			"data-reference-fallback-src",
			"https://example.com/image-thumb.jpg",
		);
		expect(screen.getByRole("img", { name: "推文视频封面 2" })).toHaveAttribute(
			"src",
			"https://example.com/video-cover.jpg",
		);
		expect(
			screen.getByRole("img", { name: "推文 GIF 封面 3" }),
		).toHaveAttribute("src", "https://example.com/gif-cover.jpg");
		expect(screen.getByRole("img", { name: "推文媒体预览 4" })).toHaveAttribute(
			"src",
			"https://example.com/media-cover.jpg",
		);
	});

	it("deduplicates sources and drops unsafe media URLs", () => {
		render(
			<ReferencePrintMedia
				items={[
					image(1),
					{ ...image(2), url: image(1).url },
					{ type: "image", url: "javascript:alert(1)" },
					{
						thumbnailUrl: "data:image/png;base64,unsafe",
						type: "video",
						url: "https://example.com/video.mp4",
					},
				]}
			/>,
		);

		expect(screen.getAllByRole("img")).toHaveLength(1);
		expect(screen.getByRole("img")).toHaveAttribute(
			"src",
			"https://example.com/image-1.jpg",
		);
	});

	it("uses full-resolution images with eager loading and a thumbnail fallback", () => {
		render(
			<ReferencePrintMedia
				items={[
					{
						altText: "  自定义图片说明  ",
						height: 900,
						thumbnailUrl: "https://example.com/photo-thumb.jpg",
						type: "image",
						url: "https://example.com/photo-original.jpg",
						width: 1600,
					},
				]}
			/>,
		);

		const renderedImage = screen.getByRole("img", {
			name: "自定义图片说明",
		});
		expect(renderedImage).toHaveAttribute("loading", "eager");
		expect(renderedImage).toHaveAttribute("decoding", "sync");
		expect(renderedImage).toHaveAttribute("width", "1600");
		expect(renderedImage).toHaveAttribute("height", "900");
		expect(renderedImage).toHaveAttribute(
			"src",
			"https://example.com/photo-original.jpg",
		);
		expect(renderedImage).toHaveAttribute(
			"data-reference-fallback-src",
			"https://example.com/photo-thumb.jpg",
		);
	});
});
