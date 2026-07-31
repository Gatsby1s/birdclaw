import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import {
	tweetTranslationRequestSchema,
	tweetTranslationResponseSchema,
} from "#/lib/api-contracts";
import {
	jsonResponse,
	requestJsonEffect,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import { translateTweetTextEffect } from "#/lib/tweet-translation";

export const Route = createFileRoute("/api/tweet-translation")({
	server: {
		handlers: {
			POST: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						const input = yield* requestJsonEffect<unknown>(request, null);
						const parsed = tweetTranslationRequestSchema.safeParse(input);
						if (!parsed.success) {
							return jsonResponse(
								{ ok: false, message: "Invalid translation request" },
								{ status: 400 },
							);
						}

						const result = yield* translateTweetTextEffect(parsed.data.text, {
							signal: request.signal,
						});
						return jsonResponse(
							tweetTranslationResponseSchema.parse({
								ok: true,
								tweetId: parsed.data.tweetId,
								...result,
							}),
						);
					}).pipe(
						Effect.catchAll(() =>
							Effect.succeed(
								jsonResponse(
									{ ok: false, message: "Translation temporarily unavailable" },
									{ status: 502 },
								),
							),
						),
					),
				),
		},
	},
});
