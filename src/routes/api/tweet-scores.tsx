import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import {
	tweetScoresRequestSchema,
	tweetScoresResponseSchema,
} from "#/lib/api-contracts";
import {
	jsonResponse,
	requestJsonEffect,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import { createRequestAdmission } from "#/lib/request-admission";
import { scoreTweetsEffect } from "#/lib/tweet-score";

const scoreRequestAdmission = createRequestAdmission(1);
const SCORE_REQUEST_TIMEOUT_MS = 90_000;

export const Route = createFileRoute("/api/tweet-scores")({
	server: {
		handlers: {
			POST: ({ request }) => {
				const denied = sensitiveRequestErrorResponse(request);
				if (denied) return Promise.resolve(denied);
				const release = scoreRequestAdmission.tryAcquire();
				if (!release) {
					return Promise.resolve(
						jsonResponse(
							{ ok: false, message: "评分请求繁忙，请稍后再试" },
							{ status: 429, headers: { "retry-after": "2" } },
						),
					);
				}
				const workSignal = AbortSignal.any([
					request.signal,
					AbortSignal.timeout(SCORE_REQUEST_TIMEOUT_MS),
				]);
				return runRouteEffect(
					Effect.gen(function* () {
						const input = yield* requestJsonEffect<unknown>(request, null);
						const parsed = tweetScoresRequestSchema.safeParse(input);
						if (!parsed.success) {
							return jsonResponse(
								{ ok: false, message: "评分请求无效" },
								{ status: 400 },
							);
						}

						const scores = yield* scoreTweetsEffect(parsed.data.tweets, {
							signal: workSignal,
						});
						return jsonResponse(
							tweetScoresResponseSchema.parse({ ok: true, scores }),
						);
					}).pipe(
						Effect.catchAll(() =>
							Effect.succeed(
								jsonResponse(
									{ ok: false, message: "评分暂时不可用" },
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
