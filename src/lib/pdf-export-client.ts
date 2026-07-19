export type PdfPrintMode = "summary" | "reference";

export interface ReferencePdfExportOptions {
	title: string;
	sourceSelector: string;
	onCleanup: () => void;
}

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
		if (document.fonts) await document.fonts.ready;
		const { Previewer } = await import("pagedjs");
		const previewer = new Previewer();
		const previewSource = source.cloneNode(true) as HTMLElement;
		previewSource.style.display = "block";
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
