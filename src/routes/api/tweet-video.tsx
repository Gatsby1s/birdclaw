import { createFileRoute } from "@tanstack/react-router";
import { sensitiveRequestErrorResponse } from "#/lib/http-effect";
import { proxyTweetVideoRequest } from "#/lib/tweet-video-proxy";

export const Route = createFileRoute("/api/tweet-video")({
	server: {
		handlers: {
			GET: ({ request }) => {
				const denied = sensitiveRequestErrorResponse(request);
				if (denied) return denied;
				return proxyTweetVideoRequest(request);
			},
		},
	},
});
