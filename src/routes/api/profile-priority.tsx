import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { z } from "zod";
import { profilePriorityStatusSchema } from "#/lib/api-contracts";
import { databaseWriteEffect } from "#/lib/database-writer";
import {
	jsonResponse,
	requestJsonEffect,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import {
	getOrPromoteProfilePriority,
	setProfileSpecialFollow,
} from "#/lib/profile-priority";

const profilePriorityRequestSchema = z.object({
	handle: z.string().trim().min(1).max(100),
	identifier: z.string().trim().min(1).max(128).optional(),
	specialFollow: z.boolean(),
});

export const Route = createFileRoute("/api/profile-priority")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;
						const url = new URL(request.url);
						const handle = url.searchParams.get("handle")?.trim() ?? "";
						const identifier = url.searchParams.get("identifier")?.trim();
						const status = yield* databaseWriteEffect((db) =>
							getOrPromoteProfilePriority(
								{
									handle: handle.slice(0, 100),
									...(identifier
										? { identifier: identifier.slice(0, 128) }
										: {}),
								},
								db,
							),
						);
						return jsonResponse(profilePriorityStatusSchema.parse(status));
					}),
				),
			PATCH: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;
						const input = yield* requestJsonEffect(request, {});
						const parsed = profilePriorityRequestSchema.safeParse(input);
						if (!parsed.success) {
							return jsonResponse(
								{ ok: false, message: "Choose a valid profile priority." },
								{ status: 400 },
							);
						}
						const status = yield* databaseWriteEffect((db) =>
							setProfileSpecialFollow(parsed.data, db),
						);
						return jsonResponse(profilePriorityStatusSchema.parse(status));
					}),
				),
		},
	},
});
