import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { twitter6551RuntimeStatusSchema } from "#/lib/api-contracts";
import {
	jsonResponse,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import {
	getTwitter6551RuntimeStatus,
	runTwitter6551Backfill,
} from "#/lib/twitter-6551";

export const Route = createFileRoute("/api/integrations/twitter6551")({
	server: {
		handlers: {
			GET: ({ request }) => {
				const denied = sensitiveRequestErrorResponse(request);
				if (denied) return denied;
				return jsonResponse(
					twitter6551RuntimeStatusSchema.parse(getTwitter6551RuntimeStatus()),
				);
			},
			POST: ({ request }) =>
				runRouteEffect(
					Effect.tryPromise({
						try: async () => {
							const denied = sensitiveRequestErrorResponse(request);
							if (denied) return denied;
							return jsonResponse(
								twitter6551RuntimeStatusSchema.parse(
									await runTwitter6551Backfill(),
								),
							);
						},
						catch: (error) =>
							error instanceof Error ? error : new Error(String(error)),
					}).pipe(
						Effect.catchAll((error) =>
							Effect.succeed(
								jsonResponse(
									{ ok: false, message: error.message },
									{ status: 503 },
								),
							),
						),
					),
				),
		},
	},
});
