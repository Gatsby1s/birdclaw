import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { expandedTweetTextResponseSchema } from "#/lib/api-contracts";
import { expandRetweetedTextViaBirdEffect } from "#/lib/bird";
import {
	jsonResponse,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";

const TWEET_ID_PATTERN = /^\d{1,30}$/;

export const Route = createFileRoute("/api/tweet-expand")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						const url = new URL(request.url);
						const tweetId = url.searchParams.get("tweetId")?.trim();
						if (!tweetId) {
							return jsonResponse(
								{ ok: false, message: "Missing tweetId" },
								{ status: 400 },
							);
						}
						if (!TWEET_ID_PATTERN.test(tweetId)) {
							return jsonResponse(
								{ ok: false, message: "Invalid tweetId" },
								{ status: 400 },
							);
						}

						const expanded = yield* expandRetweetedTextViaBirdEffect(
							tweetId,
						).pipe(
							Effect.map((result) => ({ ok: true as const, result })),
							Effect.catchAll(() => Effect.succeed({ ok: false as const })),
						);
						if (!expanded.ok) {
							return jsonResponse(
								{ ok: false, message: "Full repost unavailable" },
								{ status: 502 },
							);
						}

						return jsonResponse(
							expandedTweetTextResponseSchema.parse({
								ok: true,
								...expanded.result,
							}),
						);
					}),
				),
		},
	},
});
