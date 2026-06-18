import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { profileHydrationResponseSchema } from "#/lib/api-contracts";
import {
	jsonResponse,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import { resolveProfilesForHandlesEffect } from "#/lib/profile-resolver";

function parseHandles(url: URL) {
	const rawValues = [
		...url.searchParams.getAll("handle"),
		...(url.searchParams.get("handles")?.split(",") ?? []),
	];
	return Array.from(
		new Set(
			rawValues
				.map((value) => value.trim().replace(/^@/, ""))
				.filter((value) => /^[A-Za-z0-9_]{1,15}$/.test(value)),
		),
	).slice(0, 50);
}

export const Route = createFileRoute("/api/profile-hydrate")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						const url = new URL(request.url);
						const handles = parseHandles(url);
						if (handles.length === 0) {
							return jsonResponse(
								{ ok: false, message: "Missing handles" },
								{ status: 400 },
							);
						}

						const results = yield* resolveProfilesForHandlesEffect(handles);
						return jsonResponse(
							profileHydrationResponseSchema.parse({
								ok: true,
								results,
								hydratedProfiles: results.filter(
									(result) => result.status === "hit",
								).length,
							}),
						);
					}),
				),
		},
	},
});
