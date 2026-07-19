export type PdfPrintMode = "summary" | "reference";

export interface ReferencePdfExportOptions {
	title: string;
	sourceSelector: string;
	onCleanup: () => void;
}

const REFERENCE_IMAGE_ATTEMPT_TIMEOUT_MS = 4_000;
const REFERENCE_ULTRA_TALL_RATIO = 0.35;
const REFERENCE_PORTRAIT_RATIO = 0.85;
const REFERENCE_SQUARE_RATIO = 1.2;
const REFERENCE_TALL_SLICE_WIDTH_MM = 55;
const REFERENCE_TALL_SLICE_MAX_HEIGHT_MM = 185;
const REFERENCE_TALL_SLICE_MAX_COLUMNS = 3;

type ResolvedReferenceImage = {
	height: number;
	loaded: boolean;
	width: number;
};

export function exportCurrentPdf(
	title: string,
	mode: PdfPrintMode = "summary",
	onCleanup?: () => void,
) {
	const previousTitle = document.title;
	const previousPrintMode = document.body.dataset.todayPrintMode;
	let cleanedUp = false;
	const cleanup = () => {
		if (cleanedUp) return;
		cleanedUp = true;
		document.title = previousTitle;
		if (previousPrintMode === undefined) {
			delete document.body.dataset.todayPrintMode;
		} else {
			document.body.dataset.todayPrintMode = previousPrintMode;
		}
		window.removeEventListener("afterprint", cleanup);
		onCleanup?.();
	};

	document.title = title;
	document.body.dataset.todayPrintMode = mode;
	window.addEventListener("afterprint", cleanup, { once: true });
	window.setTimeout(cleanup, 3000);
	window.print();
}

function collectReferencePrintStylesheets() {
	const pagedPrintRules: string[] = [];
	for (const stylesheet of document.styleSheets) {
		try {
			for (const rule of stylesheet.cssRules) {
				if (
					!(rule instanceof CSSMediaRule) ||
					!rule.conditionText.split(",").some((item) => item.trim() === "print")
				) {
					continue;
				}
				for (const printRule of rule.cssRules) {
					pagedPrintRules.push(printRule.cssText);
				}
			}
		} catch {
			// Reference print rules live in same-origin app stylesheets.
		}
	}
	return [
		{
			[`${window.location.href}#reference-print-page-size`]: `
			${pagedPrintRules.join("\n")}
			@page {
				size: A4;
				margin: 16mm 16mm 17mm;
			}
			@page reference {
				size: A4;
				margin: 16mm 16mm 17mm;
			}
			.today-reference-pdf {
				display: block !important;
				page: reference;
			}
		`,
		},
	];
}

function waitForImageAttempt(image: HTMLImageElement, timeoutMs: number) {
	if (image.complete) return Promise.resolve(image.naturalWidth > 0);

	return new Promise<boolean>((resolve) => {
		let settled = false;
		const finish = (loaded: boolean) => {
			if (settled) return;
			settled = true;
			window.clearTimeout(timer);
			image.removeEventListener("load", handleLoad);
			image.removeEventListener("error", handleError);
			resolve(loaded);
		};
		const handleLoad = () => finish(true);
		const handleError = () => finish(false);
		const timer = window.setTimeout(() => finish(false), timeoutMs);
		image.addEventListener("load", handleLoad, { once: true });
		image.addEventListener("error", handleError, { once: true });
		if (image.complete) finish(image.naturalWidth > 0);
	});
}

async function resolveReferencePrintImage(
	image: HTMLImageElement,
	timeoutMs: number,
) {
	if (await waitForImageAttempt(image, timeoutMs)) return true;
	const fallback = image.dataset.referenceFallbackSrc;
	if (!fallback || fallback === image.currentSrc || fallback === image.src) {
		return false;
	}
	delete image.dataset.referenceFallbackSrc;
	image.src = fallback;
	return waitForImageAttempt(image, timeoutMs);
}

function replaceFailedReferenceImage(image: HTMLImageElement) {
	const placeholder = document.createElement("span");
	placeholder.className = "today-reference-media-unavailable";
	placeholder.setAttribute("role", "img");
	placeholder.setAttribute(
		"aria-label",
		image.alt ? `${image.alt}（加载失败）` : "推文图片加载失败",
	);
	placeholder.textContent = "图片暂时无法加载";
	image.replaceWith(placeholder);
}

function referenceImageShape(width: number, height: number) {
	const ratio = width / height;
	if (ratio < REFERENCE_ULTRA_TALL_RATIO) return "ultra-tall";
	if (ratio < REFERENCE_PORTRAIT_RATIO) return "portrait";
	if (ratio <= REFERENCE_SQUARE_RATIO) return "square";
	return "landscape";
}

function createTallImageSlice(
	image: HTMLImageElement,
	width: number,
	height: number,
	sliceIndex: number,
	sliceCount: number,
) {
	const sliceStart = Math.floor((height * sliceIndex) / sliceCount);
	const sliceEnd = Math.floor((height * (sliceIndex + 1)) / sliceCount);
	const sliceHeight = Math.max(1, sliceEnd - sliceStart);
	const slice = document.createElement("figure");
	slice.className = "today-reference-media-slice";
	slice.dataset.referenceSliceIndex = String(sliceIndex + 1);
	slice.dataset.referenceSliceTotal = String(sliceCount);
	slice.style.setProperty(
		"--reference-slice-ratio",
		`${String(width)} / ${String(sliceHeight)}`,
	);

	const sliceImage = image.cloneNode(true) as HTMLImageElement;
	sliceImage.classList.add("today-reference-media-slice-image");
	sliceImage.removeAttribute("height");
	sliceImage.removeAttribute("width");
	sliceImage.alt = image.alt
		? `${image.alt}（第 ${String(sliceIndex + 1)}/${String(sliceCount)} 段）`
		: `推文长图（第 ${String(sliceIndex + 1)}/${String(sliceCount)} 段）`;
	sliceImage.style.setProperty(
		"--reference-slice-offset",
		`${String((-sliceStart / height) * 100)}%`,
	);
	slice.append(sliceImage);
	return slice;
}

function sliceUltraTallReferenceImage(
	image: HTMLImageElement,
	width: number,
	height: number,
) {
	const figure = image.closest("figure");
	if (!figure) return;
	const printedHeight = (REFERENCE_TALL_SLICE_WIDTH_MM * height) / width;
	const sliceCount = Math.max(
		2,
		Math.ceil(printedHeight / REFERENCE_TALL_SLICE_MAX_HEIGHT_MM),
	);
	const rows: HTMLDivElement[] = [];

	for (
		let rowStart = 0;
		rowStart < sliceCount;
		rowStart += REFERENCE_TALL_SLICE_MAX_COLUMNS
	) {
		const rowEnd = Math.min(
			rowStart + REFERENCE_TALL_SLICE_MAX_COLUMNS,
			sliceCount,
		);
		const row = document.createElement("div");
		row.className = "today-reference-media-sliced";
		row.dataset.referenceImageHeight = String(height);
		row.dataset.referenceImageShape = "ultra-tall";
		row.dataset.referenceImageWidth = String(width);
		row.dataset.referenceSliceCount = String(sliceCount);
		row.style.setProperty(
			"--reference-slice-columns",
			String(rowEnd - rowStart),
		);
		for (let index = rowStart; index < rowEnd; index += 1) {
			row.append(createTallImageSlice(image, width, height, index, sliceCount));
		}
		rows.push(row);
	}

	figure.replaceWith(...rows);
}

function prepareReadableReferenceImage(
	image: HTMLImageElement,
	resolved: ResolvedReferenceImage,
) {
	if (resolved.width <= 0 || resolved.height <= 0) return;
	image.setAttribute("width", String(resolved.width));
	image.setAttribute("height", String(resolved.height));
	const shape = referenceImageShape(resolved.width, resolved.height);
	if (shape === "ultra-tall") {
		sliceUltraTallReferenceImage(image, resolved.width, resolved.height);
		return;
	}
	const figure = image.closest("figure");
	if (figure) {
		figure.dataset.referenceImageHeight = String(resolved.height);
		figure.dataset.referenceImageShape = shape;
		figure.dataset.referenceImageWidth = String(resolved.width);
	}
}

export async function prepareReferencePrintSource(
	source: HTMLElement,
	imageAttemptTimeoutMs = REFERENCE_IMAGE_ATTEMPT_TIMEOUT_MS,
) {
	const images = [...source.querySelectorAll<HTMLImageElement>("img")];
	const resolved = await Promise.all(
		images.map(async (image): Promise<ResolvedReferenceImage> => {
			const loaded = await resolveReferencePrintImage(
				image,
				imageAttemptTimeoutMs,
			);
			return {
				height: loaded ? image.naturalHeight : 0,
				loaded,
				width: loaded ? image.naturalWidth : 0,
			};
		}),
	);
	const previewSource = source.cloneNode(true) as HTMLElement;
	previewSource.style.display = "block";
	const previewImages = [
		...previewSource.querySelectorAll<HTMLImageElement>("img"),
	];
	for (const [index, image] of previewImages.entries()) {
		const imageResolution = resolved[index];
		if (!imageResolution?.loaded) {
			replaceFailedReferenceImage(image);
			continue;
		}
		prepareReadableReferenceImage(image, imageResolution);
	}
	return previewSource;
}

export async function exportReferenceCollectionPdf({
	title,
	sourceSelector,
	onCleanup,
}: ReferencePdfExportOptions) {
	const source = document.querySelector<HTMLElement>(sourceSelector);
	if (!source) {
		exportCurrentPdf(title, "reference", onCleanup);
		return;
	}

	const previousTitle = document.title;
	const previousPrintMode = document.body.dataset.todayPrintMode;
	const previousPrintStage = document.body.dataset.todayPrintStage;
	const existingPagedStyles = new Set(
		document.querySelectorAll("style[data-pagedjs-inserted-styles]"),
	);
	const previewHost = document.createElement("div");
	previewHost.className = "today-reference-paged-preview";
	previewHost.setAttribute("aria-hidden", "true");
	document.body.append(previewHost);
	document.title = title;
	document.body.dataset.todayPrintMode = "reference";
	const removeNewPagedStyles = () => {
		for (const insertedStyle of document.querySelectorAll(
			"style[data-pagedjs-inserted-styles]",
		)) {
			if (!existingPagedStyles.has(insertedStyle)) insertedStyle.remove();
		}
	};
	const restoreDocumentState = () => {
		document.title = previousTitle;
		if (previousPrintMode === undefined) {
			delete document.body.dataset.todayPrintMode;
		} else {
			document.body.dataset.todayPrintMode = previousPrintMode;
		}
		if (previousPrintStage === undefined) {
			delete document.body.dataset.todayPrintStage;
		} else {
			document.body.dataset.todayPrintStage = previousPrintStage;
		}
	};
	let preparedSource: HTMLElement | null = null;

	try {
		[preparedSource] = await Promise.all([
			prepareReferencePrintSource(source),
			document.fonts?.ready ?? Promise.resolve(),
		]);
		const { Previewer } = await import("pagedjs");
		const previewer = new Previewer();
		await previewer.preview(
			preparedSource.outerHTML,
			collectReferencePrintStylesheets(),
			previewHost,
		);
		const pageByTarget = new Map<string, number>();
		for (const [pageIndex, page] of [
			...previewHost.querySelectorAll<HTMLElement>(".pagedjs_page"),
		].entries()) {
			for (const target of page.querySelectorAll<HTMLElement>(
				'[id^="reference-topic-"], [id^="reference-source-"]',
			)) {
				if (target.id && !pageByTarget.has(target.id)) {
					pageByTarget.set(target.id, pageIndex + 1);
				}
			}
		}
		for (const pageNumber of previewHost.querySelectorAll<HTMLElement>(
			"[data-reference-page-target]",
		)) {
			const target = pageNumber.dataset.referencePageTarget;
			pageNumber.textContent = target
				? String(pageByTarget.get(target) ?? "—")
				: "—";
		}
		document.body.dataset.todayPrintStage = "paged";
	} catch (error) {
		console.warn("Paged reference PDF rendering failed", error);
		removeNewPagedStyles();
		if (preparedSource) {
			previewHost.replaceChildren(preparedSource);
			document.body.dataset.todayPrintStage = "paged";
		} else {
			previewHost.remove();
			restoreDocumentState();
			exportCurrentPdf(title, "reference", onCleanup);
			return;
		}
	}

	let cleanedUp = false;
	const cleanup = () => {
		if (cleanedUp) return;
		cleanedUp = true;
		previewHost.remove();
		removeNewPagedStyles();
		restoreDocumentState();
		window.removeEventListener("afterprint", cleanup);
		onCleanup();
	};

	window.addEventListener("afterprint", cleanup, { once: true });
	window.setTimeout(cleanup, 3000);
	window.print();
}
