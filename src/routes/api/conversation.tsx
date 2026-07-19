import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { tweetConversationResponseSchema } from "#/lib/api-contracts";
import { maybeAutoUpdateBackupEffect } from "#/lib/backup";
import {
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import { getTweetConversation } from "#/lib/timeline-read-model";
import { enrichEmbeddedTweetsWithXRemark } from "#/lib/xremark";

function json(data: unknown, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"content-type": "application/json",
		},
	});
}

export const Route = createFileRoute("/api/conversation")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						yield* maybeAutoUpdateBackupEffect();
						const url = new URL(request.url);
						const tweetId = url.searchParams.get("tweetId")?.trim();
						if (!tweetId) {
							return json({ ok: false, error: "Missing tweetId" }, 400);
						}

						const conversation = getTweetConversation(tweetId);
						if (!conversation) {
							return json({ ok: false, error: "Tweet not found" }, 404);
						}

						const response = tweetConversationResponseSchema.parse({
							ok: true,
							...conversation,
						});
						return json({
							...response,
							items: enrichEmbeddedTweetsWithXRemark(response.items),
						});
					}),
				),
		},
	},
});
