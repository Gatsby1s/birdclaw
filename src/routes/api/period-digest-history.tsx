import fs from "node:fs/promises";
import { createFileRoute } from "@tanstack/react-router";
import { ensureDailyDigestPdf } from "#/lib/daily-digest-pdf";
import {
	getPeriodDigestHistory,
	listPeriodDigestHistory,
} from "#/lib/period-digest-history";
import {
	jsonResponse,
	parseBoundedInteger,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";

function notFound() {
	return jsonResponse(
		{ ok: false, message: "Daily digest history not found" },
		{ status: 404 },
	);
}

export const Route = createFileRoute("/api/period-digest-history")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				const denied = sensitiveRequestErrorResponse(request);
				if (denied) return denied;
				const url = new URL(request.url);
				const id = url.searchParams.get("id")?.trim();
				if (!id) {
					const limit = parseBoundedInteger(url.searchParams.get("limit"), {
						defaultValue: 90,
						max: 366,
					});
					return jsonResponse({
						items: listPeriodDigestHistory({ limit }),
					});
				}
				const item = getPeriodDigestHistory(id);
				if (!item) return notFound();
				if (url.searchParams.get("pdf") !== "1") {
					return jsonResponse({ item });
				}
				try {
					const filePath = await ensureDailyDigestPdf({ id });
					const pdf = await fs.readFile(filePath);
					return new Response(pdf, {
						headers: {
							"content-type": "application/pdf",
							"content-disposition": `attachment; filename="BirdClaw-${item.metadata.date}-digest.pdf"`,
							"cache-control": "private, no-store",
						},
					});
				} catch (error) {
					return jsonResponse(
						{
							ok: false,
							message:
								error instanceof Error
									? error.message
									: "Daily digest PDF generation failed",
						},
						{ status: 503 },
					);
				}
			},
		},
	},
});
