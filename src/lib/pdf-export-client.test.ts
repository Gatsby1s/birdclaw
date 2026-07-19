import { describe, expect, it, vi } from "vitest";

const { previewMock } = vi.hoisted(() => ({
	previewMock: vi.fn(),
}));

vi.mock("pagedjs", () => ({
	Previewer: class {
		preview = previewMock;
	},
}));

import {
	exportReferenceCollectionPdf,
	prepareReferencePrintSource,
} from "./pdf-export-client";

function referenceSource(imageMarkup: string) {
	const source = document.createElement("article");
	source.style.display = "none";
	source.innerHTML = `<figure>${imageMarkup}</figure>`;
	return source;
}

function setImageState(
	image: HTMLImageElement,
	state: { complete: boolean; naturalHeight?: number; naturalWidth: number },
) {
	Object.defineProperty(image, "complete", {
		configurable: true,
		get: () => state.complete,
	});
	Object.defineProperty(image, "naturalWidth", {
		configurable: true,
		get: () => state.naturalWidth,
	});
	Object.defineProperty(image, "naturalHeight", {
		configurable: true,
		get: () => state.naturalHeight ?? (state.naturalWidth > 0 ? 800 : 0),
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

	it("sizes ordinary images by their natural shape instead of a fixed-height thumbnail", async () => {
		const source = referenceSource(
			'<img alt="Portrait screenshot" src="https://example.com/portrait.jpg">',
		);
		const image = source.querySelector("img")!;
		setImageState(image, {
			complete: true,
			naturalHeight: 1200,
			naturalWidth: 552,
		});

		const clone = await prepareReferencePrintSource(source, 10);

		expect(clone.querySelector("figure")).toHaveAttribute(
			"data-reference-image-shape",
			"portrait",
		);
		expect(clone.querySelector("img")).toHaveAttribute("width", "552");
		expect(clone.querySelector("img")).toHaveAttribute("height", "1200");
		expect(clone.querySelector(".today-reference-media-sliced")).toBeNull();
	});

	it("splits ultra-tall screenshots into readable magazine columns", async () => {
		const source = referenceSource(
			'<img alt="Long article" src="https://example.com/article.jpg">',
		);
		const image = source.querySelector("img")!;
		setImageState(image, {
			complete: true,
			naturalHeight: 1200,
			naturalWidth: 152,
		});

		const clone = await prepareReferencePrintSource(source, 10);
		const sliced = clone.querySelector(".today-reference-media-sliced");
		const slices = clone.querySelectorAll(".today-reference-media-slice");

		expect(sliced).toHaveAttribute("data-reference-image-shape", "ultra-tall");
		expect(sliced).toHaveAttribute("data-reference-slice-count", "3");
		expect(sliced).toHaveStyle("--reference-slice-columns: 3");
		expect(slices).toHaveLength(3);
		expect(clone.querySelectorAll("img")).toHaveLength(3);
		expect(slices[0]).toHaveStyle("--reference-slice-ratio: 152 / 400");
		expect(slices[2]).toHaveAttribute("data-reference-slice-index", "3");
		expect(slices[2]?.querySelector("img")).toHaveAttribute(
			"alt",
			"Long article（第 3/3 段）",
		);
		expect(source.querySelectorAll("img")).toHaveLength(1);
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

	it("prints the prepared readable clone when Paged.js fails", async () => {
		const source = referenceSource(
			'<img alt="Long article" src="https://example.com/article.jpg">',
		);
		source.className = "fallback-reference-source";
		document.body.append(source);
		const image = source.querySelector("img")!;
		setImageState(image, {
			complete: true,
			naturalHeight: 1200,
			naturalWidth: 152,
		});
		previewMock.mockRejectedValueOnce(new Error("Paged rendering failed"));
		const cleanup = vi.fn();
		const print = vi.spyOn(window, "print").mockImplementation(() => {
			const fallbackHost = document.querySelector(
				".today-reference-paged-preview",
			);
			expect(fallbackHost).not.toBeNull();
			expect(
				fallbackHost?.querySelectorAll(".today-reference-media-slice"),
			).toHaveLength(3);
			expect(document.body.dataset.todayPrintStage).toBe("paged");
		});

		await exportReferenceCollectionPdf({
			onCleanup: cleanup,
			sourceSelector: ".fallback-reference-source",
			title: "Readable fallback",
		});

		expect(print).toHaveBeenCalledTimes(1);
		window.dispatchEvent(new Event("afterprint"));
		expect(cleanup).toHaveBeenCalledTimes(1);
		expect(document.querySelector(".today-reference-paged-preview")).toBeNull();
		source.remove();
		print.mockRestore();
	});
});
