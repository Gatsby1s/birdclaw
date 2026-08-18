import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { profileListFeedResponseSchema } from "#/lib/api-contracts";
import {
	jsonResponse,
	parseBoundedInteger,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import { listProfileListFeed } from "#/lib/profile-list-feed";

export const Route = createFileRoute("/api/list-feed")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;
						const url = new URL(request.url);
						const accountId = url.searchParams.get("account")?.trim() ?? "";
						const listId = url.searchParams.get("listId")?.trim() ?? "";
						if (!accountId || !listId) {
							return jsonResponse(
								{ ok: false, message: "Choose a List." },
								{ status: 400 },
							);
						}
						const result = yield* Effect.try({
							try: () =>
								listProfileListFeed({
									accountId,
									listId,
									search: url.searchParams.get("search") ?? undefined,
									until: url.searchParams.get("until") ?? undefined,
									untilId: url.searchParams.get("untilId") ?? undefined,
									limit: parseBoundedInteger(url.searchParams.get("limit"), {
										max: 100,
									}),
								}),
							catch: (error) =>
								error instanceof Error ? error : new Error(String(error)),
						}).pipe(Effect.either);
						if (result._tag === "Left") {
							return jsonResponse(
								{ ok: false, message: "List timeline unavailable." },
								{ status: /not found/i.test(result.left.message) ? 404 : 400 },
							);
						}
						return jsonResponse(
							profileListFeedResponseSchema.parse(result.right),
						);
					}),
				),
		},
	},
});
