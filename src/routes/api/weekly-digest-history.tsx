import fs from "node:fs/promises";
import { createFileRoute } from "@tanstack/react-router";
import { ensureWeeklyDigestPdf } from "#/lib/daily-digest-pdf";
import {
	getWeeklyDigestHistory,
	listWeeklyDigestHistory,
} from "#/lib/weekly-digest-history";
import {
	jsonResponse,
	parseBoundedInteger,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";

function notFound() {
	return jsonResponse(
		{ ok: false, message: "Weekly digest history not found" },
		{ status: 404 },
	);
}

export const Route = createFileRoute("/api/weekly-digest-history")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				const denied = sensitiveRequestErrorResponse(request);
				if (denied) return denied;
				const url = new URL(request.url);
				const id = url.searchParams.get("id")?.trim();
				if (!id) {
					const limit = parseBoundedInteger(url.searchParams.get("limit"), {
						defaultValue: 52,
						max: 260,
					});
					return jsonResponse({
						items: listWeeklyDigestHistory({ limit }),
					});
				}
				const item = getWeeklyDigestHistory(id);
				if (!item) return notFound();
				if (url.searchParams.get("pdf") !== "1") {
					return jsonResponse({ item });
				}
				try {
					const filePath = await ensureWeeklyDigestPdf({ id });
					const pdf = await fs.readFile(filePath);
					return new Response(pdf, {
						headers: {
							"content-type": "application/pdf",
							"content-disposition": `attachment; filename="BirdClaw-${item.metadata.date}-weekly-digest.pdf"`,
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
									: "Weekly digest PDF generation failed",
						},
						{ status: 503 },
					);
				}
			},
		},
	},
});
