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
import { createRequestAdmission } from "#/lib/request-admission";
import { translateTweetTextEffect } from "#/lib/tweet-translation";

const translationRequestAdmission = createRequestAdmission(3);
const TRANSLATION_REQUEST_TIMEOUT_MS = 45_000;

export const Route = createFileRoute("/api/tweet-translation")({
	server: {
		handlers: {
			POST: ({ request }) => {
				const denied = sensitiveRequestErrorResponse(request);
				if (denied) return Promise.resolve(denied);
				const release = translationRequestAdmission.tryAcquire();
				if (!release) {
					return Promise.resolve(
						jsonResponse(
							{
								ok: false,
								message: "Translation queue is busy. Please retry shortly.",
							},
							{ status: 429, headers: { "retry-after": "2" } },
						),
					);
				}
				const workSignal = AbortSignal.any([
					request.signal,
					AbortSignal.timeout(TRANSLATION_REQUEST_TIMEOUT_MS),
				]);
				return runRouteEffect(
					Effect.gen(function* () {
						const input = yield* requestJsonEffect<unknown>(request, null);
						const parsed = tweetTranslationRequestSchema.safeParse(input);
						if (!parsed.success) {
							return jsonResponse(
								{ ok: false, message: "Invalid translation request" },
								{ status: 400 },
							);
						}

						const result = yield* translateTweetTextEffect(parsed.data.text, {
							signal: workSignal,
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
				).finally(release);
			},
		},
	},
});
