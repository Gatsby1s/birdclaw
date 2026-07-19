import { describe, expect, it } from "vitest";
import { prepareReferencePrintSource } from "./pdf-export-client";

function referenceSource(imageMarkup: string) {
	const source = document.createElement("article");
	source.style.display = "none";
	source.innerHTML = `<figure>${imageMarkup}</figure>`;
	return source;
}

function setImageState(
	image: HTMLImageElement,
	state: { complete: boolean; naturalWidth: number },
) {
	Object.defineProperty(image, "complete", {
		configurable: true,
		get: () => state.complete,
	});
	Object.defineProperty(image, "naturalWidth", {
		configurable: true,
		get: () => state.naturalWidth,
	});
}

describe("prepareReferencePrintSource", () => {
	it("keeps loaded images in the visible clone passed to Paged.js", async () => {
		const source = referenceSource(
			'<img alt="Loaded chart" src="https://example.com/chart.jpg">',
		);
		const image = source.querySelector("img")!;
		setImageState(image, { complete: true, naturalWidth: 1200 });

		const clone = await prepareReferencePrintSource(source, 10);

		expect(clone.style.display).toBe("block");
		expect(clone.querySelector("img")).toHaveAttribute(
			"src",
			"https://example.com/chart.jpg",
		);
		expect(source.querySelector("img")).not.toBeNull();
	});

	it("retries an image with its original source after a thumbnail error", async () => {
		const source = referenceSource(
			'<img alt="Chart" src="https://example.com/thumb.jpg" data-reference-fallback-src="https://example.com/original.jpg">',
		);
		const image = source.querySelector("img")!;
		setImageState(image, { complete: false, naturalWidth: 0 });

		const preparing = prepareReferencePrintSource(source, 100);
		image.dispatchEvent(new Event("error"));
		await Promise.resolve();
		expect(image).toHaveAttribute("src", "https://example.com/original.jpg");
		image.dispatchEvent(new Event("load"));
		const clone = await preparing;

		expect(clone.querySelector("img")).toHaveAttribute(
			"src",
			"https://example.com/original.jpg",
		);
		expect(clone.querySelector("img")).not.toHaveAttribute(
			"data-reference-fallback-src",
		);
	});

	it("replaces failed images before Paged.js can wait on them forever", async () => {
		const source = referenceSource(
			'<img alt="Unavailable chart" src="https://example.com/broken.jpg">',
		);
		const image = source.querySelector("img")!;
		setImageState(image, { complete: false, naturalWidth: 0 });

		const preparing = prepareReferencePrintSource(source, 100);
		image.dispatchEvent(new Event("error"));
		const clone = await preparing;

		expect(source.querySelector("img")).not.toBeNull();
		expect(clone.querySelector("img")).toBeNull();
		expect(
			clone.querySelector(".today-reference-media-unavailable"),
		).toHaveTextContent("图片暂时无法加载");
		expect(clone.querySelector('[role="img"]')).toHaveAttribute(
			"aria-label",
			"Unavailable chart（加载失败）",
		);
	});

	it("turns a stalled image into a placeholder after the bounded timeout", async () => {
		const source = referenceSource(
			'<img alt="Slow chart" src="https://example.com/slow.jpg">',
		);
		const image = source.querySelector("img")!;
		setImageState(image, { complete: false, naturalWidth: 0 });

		const clone = await prepareReferencePrintSource(source, 1);

		expect(clone.querySelector("img")).toBeNull();
		expect(clone.querySelector('[role="img"]')).toHaveAttribute(
			"aria-label",
			"Slow chart（加载失败）",
		);
	});
});
