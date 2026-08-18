import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { feedArticleContentResponseSchema } from "#/lib/api-contracts";
import {
	getFeedArticleContent,
	getFeedArticleItem,
} from "#/lib/editorial-feed";
import {
	jsonResponse,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";

export const Route = createFileRoute("/api/feed-article")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						const itemId = new URL(request.url).searchParams.get("id")?.trim();
						if (!itemId) {
							return jsonResponse(
								{ ok: false, message: "Missing article id" },
								{ status: 400 },
							);
						}
						if (!getFeedArticleItem(itemId)) {
							return jsonResponse(
								{ ok: false, message: "Article not found" },
								{ status: 404 },
							);
						}

						const result = yield* Effect.tryPromise({
							try: () =>
								getFeedArticleContent(itemId, { signal: request.signal }),
							catch: () =>
								new Error("Article content is temporarily unavailable"),
						}).pipe(Effect.catchAll(() => Effect.succeed(null)));
						if (!result) {
							return jsonResponse(
								{
									ok: false,
									message: "Article content is temporarily unavailable",
								},
								{ status: 502 },
							);
						}

						return jsonResponse(
							feedArticleContentResponseSchema.parse({
								ok: true,
								item: result.item,
								content: result.content,
								contentHash: result.contentHash,
								cached: result.cached,
								fetchedAt: result.fetchedAt,
							}),
							{ headers: { "cache-control": "private, no-store" } },
						);
					}),
				),
		},
	},
});
