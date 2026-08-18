import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { feedSyncResponseSchema, type FeedItemKind } from "#/lib/api-contracts";
import { syncTigerFeed } from "#/lib/editorial-feed";
import {
	jsonResponse,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";

function parseKind(value: string | null): FeedItemKind {
	return value === "article" ? "article" : "flash";
}

export const Route = createFileRoute("/api/feed-sync")({
	server: {
		handlers: {
			POST: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;
						const kind = parseKind(
							new URL(request.url).searchParams.get("kind"),
						);
						const result = yield* Effect.tryPromise({
							try: () => syncTigerFeed(kind, { signal: request.signal }),
							catch: (error) =>
								error instanceof Error ? error : new Error(String(error)),
						});
						return jsonResponse(
							feedSyncResponseSchema.parse({ ok: true, results: [result] }),
						);
					}),
				),
		},
	},
});
