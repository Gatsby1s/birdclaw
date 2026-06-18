import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { linkPreviewResponseSchema } from "#/lib/api-contracts";
import {
	jsonResponse,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import { getOrFetchLinkPreviewEffect } from "#/lib/link-preview-metadata";

function parseUrl(value: string | null) {
	if (!value) return null;
	try {
		const parsed = new URL(value);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return null;
		}
		return parsed.toString();
	} catch {
		return null;
	}
}

export const Route = createFileRoute("/api/link-preview")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						const url = new URL(request.url);
						const previewUrl = parseUrl(url.searchParams.get("url"));
						if (!previewUrl) {
							return jsonResponse(
								{ ok: false, message: "Missing url" },
								{ status: 400 },
							);
						}

						const preview = yield* getOrFetchLinkPreviewEffect(previewUrl);
						return jsonResponse(
							linkPreviewResponseSchema.parse({ ok: true, preview }),
						);
					}),
				),
		},
	},
});
