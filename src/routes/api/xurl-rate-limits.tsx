import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { xurlRateLimitSnapshotSchema } from "#/lib/api-contracts";
import {
	jsonResponse,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import { getXurlRateLimitSnapshot } from "#/lib/xurl-rate-limits";

export const Route = createFileRoute("/api/xurl-rate-limits")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.sync(() => {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						return jsonResponse(
							xurlRateLimitSnapshotSchema.parse(getXurlRateLimitSnapshot()),
						);
					}),
				),
		},
	},
});
