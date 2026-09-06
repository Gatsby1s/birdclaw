import { createFileRoute } from "@tanstack/react-router";
import { getReadDb } from "#/lib/db";
import { jsonResponse, sensitiveRequestErrorResponse } from "#/lib/http-effect";
import { getPersonItems } from "#/lib/person-archive-store";
export const Route = createFileRoute("/api/person-items")({
	server: {
		handlers: {
			GET: ({ request }) => {
				const denied = sensitiveRequestErrorResponse(request);
				if (denied) return denied;
				const p = new URL(request.url).searchParams;
				try {
					return jsonResponse({
						ok: true,
						...getPersonItems(getReadDb({ seedDemoData: false }), {
							personId: p.get("personId") ?? "",
							kind: p.get("kind") ?? "all",
							itemId: p.get("itemId")?.slice(0, 100),
							q: p.get("q")?.slice(0, 500),
							before: p.get("before") ?? undefined,
						}),
					});
				} catch {
					return jsonResponse(
						{ ok: false, message: "人物或翻页位置无效。" },
						{ status: 400 },
					);
				}
			},
		},
	},
});
