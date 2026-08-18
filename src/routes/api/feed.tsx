import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { feedResponseSchema, type FeedItemKind } from "#/lib/api-contracts";
import { maybeAutoUpdateBackupEffect } from "#/lib/backup";
import {
	countFeedItems,
	getFeedSyncStatus,
	listFeedItems,
} from "#/lib/editorial-feed";
import {
	jsonResponse,
	parseBoundedInteger,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";

function parseKind(value: string | null): FeedItemKind {
	return value === "article" ? "article" : "flash";
}

export const Route = createFileRoute("/api/feed")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;
						yield* maybeAutoUpdateBackupEffect();
						const url = new URL(request.url);
						const kind = parseKind(url.searchParams.get("kind"));
						const limit =
							parseBoundedInteger(url.searchParams.get("limit"), {
								max: 200,
							}) ?? 100;
						const offset =
							parseBoundedInteger(url.searchParams.get("offset"), {
								max: 100_000,
							}) ?? 0;
						return jsonResponse(
							feedResponseSchema.parse({
								ok: true,
								kind,
								items: listFeedItems({ kind, limit, offset }),
								total: countFeedItems({ kind }),
								status: getFeedSyncStatus(kind),
							}),
						);
					}),
				),
		},
	},
});
