import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { tweetConversationResponseSchema } from "#/lib/api-contracts";
import {
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import { createRequestAdmission } from "#/lib/request-admission";
import { getTweetConversation } from "#/lib/timeline-read-model";
import { enrichEmbeddedTweetsWithXRemark } from "#/lib/xremark";

const conversationRequestAdmission = createRequestAdmission(8);

function json(data: unknown, status = 200, headers?: HeadersInit) {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"content-type": "application/json",
			...Object.fromEntries(new Headers(headers).entries()),
		},
	});
}

export const Route = createFileRoute("/api/conversation")({
	server: {
		handlers: {
			GET: ({ request }) => {
				const denied = sensitiveRequestErrorResponse(request);
				if (denied) return Promise.resolve(denied);
				const release = conversationRequestAdmission.tryAcquire();
				if (!release) {
					return Promise.resolve(
						json({ ok: false, error: "Conversation requests are busy" }, 429, {
							"retry-after": "1",
						}),
					);
				}
				return runRouteEffect(
					Effect.sync(() => {
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
				).finally(release);
			},
		},
	},
});
