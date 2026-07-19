export type PdfPrintMode = "summary" | "reference";

export interface ReferencePdfExportOptions {
	title: string;
	sourceSelector: string;
	onCleanup: () => void;
}

const REFERENCE_IMAGE_ATTEMPT_TIMEOUT_MS = 4_000;

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

export async function prepareReferencePrintSource(
	source: HTMLElement,
	imageAttemptTimeoutMs = REFERENCE_IMAGE_ATTEMPT_TIMEOUT_MS,
) {
	const images = [...source.querySelectorAll<HTMLImageElement>("img")];
	const loaded = await Promise.all(
		images.map((image) =>
			resolveReferencePrintImage(image, imageAttemptTimeoutMs),
		),
	);
	const previewSource = source.cloneNode(true) as HTMLElement;
	previewSource.style.display = "block";
	const previewImages = [
		...previewSource.querySelectorAll<HTMLImageElement>("img"),
	];
	for (const [index, image] of previewImages.entries()) {
		if (!loaded[index]) replaceFailedReferenceImage(image);
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

	try {
		const [previewSource] = await Promise.all([
			prepareReferencePrintSource(source),
			document.fonts?.ready ?? Promise.resolve(),
		]);
		const { Previewer } = await import("pagedjs");
		const previewer = new Previewer();
		await previewer.preview(
			previewSource.outerHTML,
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
		previewHost.remove();
		removeNewPagedStyles();
		restoreDocumentState();
		exportCurrentPdf(title, "reference", onCleanup);
		return;
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
