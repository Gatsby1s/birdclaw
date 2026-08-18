import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { z } from "zod";
import {
	profileListCollectionSchema,
	profileListSummarySchema,
} from "#/lib/api-contracts";
import { databaseWriteEffect } from "#/lib/database-writer";
import {
	jsonResponse,
	requestJsonEffect,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import {
	createProfileList,
	deleteProfileList,
	listProfileLists,
	updateProfileList,
} from "#/lib/profile-lists";

const createRequestSchema = z.object({
	accountId: z.string().trim().min(1).max(128),
	name: z.string().trim().min(1).max(100),
	description: z.string().max(500).optional(),
});

const updateRequestSchema = createRequestSchema.extend({
	listId: z.string().trim().min(1).max(128),
});

const deleteRequestSchema = z.object({
	accountId: z.string().trim().min(1).max(128),
	listId: z.string().trim().min(1).max(128),
});

function listErrorResponse(error: unknown) {
	const message =
		error instanceof Error ? error.message : "List request failed.";
	return jsonResponse(
		{ ok: false, message },
		{ status: /not found/i.test(message) ? 404 : 400 },
	);
}

export const Route = createFileRoute("/api/lists")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.sync(() => {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;
						const accountId = new URL(request.url).searchParams
							.get("account")
							?.trim();
						if (!accountId || accountId.length > 128) {
							return jsonResponse(
								{ ok: false, message: "Choose a BirdClaw account." },
								{ status: 400 },
							);
						}
						return jsonResponse(
							profileListCollectionSchema.parse({
								lists: listProfileLists(accountId),
							}),
						);
					}),
				),
			POST: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;
						const parsed = createRequestSchema.safeParse(
							yield* requestJsonEffect(request, {}),
						);
						if (!parsed.success) {
							return jsonResponse(
								{ ok: false, message: "Choose a valid List name." },
								{ status: 400 },
							);
						}
						const result = yield* databaseWriteEffect((db) =>
							createProfileList(parsed.data, db),
						).pipe(Effect.either);
						return result._tag === "Left"
							? listErrorResponse(result.left)
							: jsonResponse(profileListSummarySchema.parse(result.right), {
									status: 201,
								});
					}),
				),
			PATCH: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;
						const parsed = updateRequestSchema.safeParse(
							yield* requestJsonEffect(request, {}),
						);
						if (!parsed.success) {
							return jsonResponse(
								{ ok: false, message: "Choose a valid List." },
								{ status: 400 },
							);
						}
						const result = yield* databaseWriteEffect((db) =>
							updateProfileList(parsed.data, db),
						).pipe(Effect.either);
						return result._tag === "Left"
							? listErrorResponse(result.left)
							: jsonResponse(profileListSummarySchema.parse(result.right));
					}),
				),
			DELETE: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;
						const parsed = deleteRequestSchema.safeParse(
							yield* requestJsonEffect(request, {}),
						);
						if (!parsed.success) {
							return jsonResponse(
								{ ok: false, message: "Choose a valid List." },
								{ status: 400 },
							);
						}
						const result = yield* databaseWriteEffect((db) =>
							deleteProfileList(parsed.data, db),
						).pipe(Effect.either);
						return result._tag === "Left"
							? listErrorResponse(result.left)
							: jsonResponse(result.right);
					}),
				),
		},
	},
});
