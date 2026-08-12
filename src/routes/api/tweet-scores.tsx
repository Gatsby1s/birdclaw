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
import { scoreTweetsEffect } from "#/lib/tweet-score";

export const Route = createFileRoute("/api/tweet-scores")({
	server: {
		handlers: {
			POST: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						const input = yield* requestJsonEffect<unknown>(request, null);
						const parsed = tweetScoresRequestSchema.safeParse(input);
						if (!parsed.success) {
							return jsonResponse(
								{ ok: false, message: "评分请求无效" },
								{ status: 400 },
							);
						}

						const scores = yield* scoreTweetsEffect(parsed.data.tweets, {
							signal: request.signal,
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
				),
		},
	},
});
