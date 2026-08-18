import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { z } from "zod";
import {
	profileListMembersResponseSchema,
	profileListMembershipStatusSchema,
} from "#/lib/api-contracts";
import { databaseWriteEffect } from "#/lib/database-writer";
import {
	jsonResponse,
	requestJsonEffect,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import {
	getProfileList,
	getProfileListMembershipStatus,
	listProfileListMembers,
	searchProfileListCandidates,
	setProfileListMembership,
} from "#/lib/profile-lists";

const membershipRequestSchema = z.object({
	accountId: z.string().trim().min(1).max(128),
	listId: z.string().trim().min(1).max(128),
	handle: z.string().trim().min(1).max(100),
	identifier: z.string().trim().min(1).max(128).optional(),
	included: z.boolean(),
});

export const Route = createFileRoute("/api/list-members")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.sync(() => {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;
						const url = new URL(request.url);
						const accountId = url.searchParams.get("account")?.trim() ?? "";
						const profileHandle =
							url.searchParams.get("profileHandle")?.trim() ?? "";
						const identifier =
							url.searchParams.get("identifier")?.trim() || undefined;
						if (!accountId || accountId.length > 128) {
							return jsonResponse(
								{ ok: false, message: "Choose a BirdClaw account." },
								{ status: 400 },
							);
						}
						if (profileHandle) {
							const status = getProfileListMembershipStatus({
								accountId,
								handle: profileHandle,
								identifier,
							});
							return jsonResponse(
								profileListMembershipStatusSchema.parse(status),
							);
						}
						const listId = url.searchParams.get("listId")?.trim() ?? "";
						if (!listId) {
							return jsonResponse(
								{ ok: false, message: "Choose a List." },
								{ status: 400 },
							);
						}
						const list = getProfileList(accountId, listId);
						if (!list) {
							return jsonResponse(
								{ ok: false, message: "List not found." },
								{ status: 404 },
							);
						}
						const search = url.searchParams.get("search")?.trim() ?? "";
						return jsonResponse(
							profileListMembersResponseSchema.parse({
								list,
								members: listProfileListMembers({ accountId, listId }),
								candidates: search
									? searchProfileListCandidates({
											accountId,
											listId,
											search,
										})
									: [],
							}),
						);
					}),
				),
			PATCH: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;
						const parsed = membershipRequestSchema.safeParse(
							yield* requestJsonEffect(request, {}),
						);
						if (!parsed.success) {
							return jsonResponse(
								{ ok: false, message: "Choose a valid profile and List." },
								{ status: 400 },
							);
						}
						const result = yield* databaseWriteEffect((db) =>
							setProfileListMembership(parsed.data, db),
						).pipe(Effect.either);
						if (result._tag === "Left") {
							const message =
								result.left instanceof Error
									? result.left.message
									: "List membership could not be saved.";
							return jsonResponse(
								{ ok: false, message },
								{ status: /not found/i.test(message) ? 404 : 400 },
							);
						}
						return jsonResponse(result.right);
					}),
				),
		},
	},
});
