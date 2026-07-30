import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import {
	localBookmarkRequestSchema,
	localBookmarkResponseSchema,
} from "#/lib/api-contracts";
import {
	jsonResponse,
	requestJsonEffect,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import { setLocalBookmarkEffect } from "#/lib/local-bookmarks";

export const Route = createFileRoute("/api/bookmark")({
	server: {
		handlers: {
			POST: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						const input = yield* requestJsonEffect<unknown>(request);
						const parsed = localBookmarkRequestSchema.safeParse(input);
						if (!parsed.success) {
							return jsonResponse(
								{ ok: false, message: "Invalid bookmark update" },
								{ status: 400 },
							);
						}

						const result = yield* setLocalBookmarkEffect(parsed.data);
						if (!result.ok) {
							return jsonResponse(
								{
									ok: false,
									message:
										result.reason === "tweet-not-found"
											? "Tweet not found"
											: "Account not found",
								},
								{ status: 404 },
							);
						}

						return jsonResponse(localBookmarkResponseSchema.parse(result));
					}),
				),
		},
	},
});
