import { createFileRoute } from "@tanstack/react-router";
import {
	specialFollowPositionResponseSchema,
	specialFollowPositionWriteRequestSchema,
	specialFollowPositionWriteResponseSchema,
} from "#/lib/api-contracts";
import { enqueueDatabaseWrite } from "#/lib/database-writer";
import { jsonResponse, sensitiveRequestErrorResponse } from "#/lib/http-effect";
import {
	getSpecialFollowPosition,
	saveSpecialFollowPosition,
	SpecialFollowPositionError,
} from "#/lib/special-follow-position";

export const Route = createFileRoute("/api/special-follow-position")({
	server: {
		handlers: {
			GET: ({ request }) => {
				const denied = sensitiveRequestErrorResponse(request);
				if (denied) return denied;
				const accountId =
					new URL(request.url).searchParams.get("account")?.trim() ?? "";
				try {
					return jsonResponse(
						specialFollowPositionResponseSchema.parse(
							getSpecialFollowPosition(accountId),
						),
					);
				} catch (error) {
					if (error instanceof SpecialFollowPositionError) {
						return jsonResponse(
							{ ok: false, message: error.message },
							{ status: error.status },
						);
					}
					throw error;
				}
			},
			PATCH: async ({ request }) => {
				const denied = sensitiveRequestErrorResponse(request);
				if (denied) return denied;
				const parsed = specialFollowPositionWriteRequestSchema.safeParse(
					await request.json().catch(() => null),
				);
				if (!parsed.success) {
					return jsonResponse(
						{ ok: false, message: "Choose a valid reading position." },
						{ status: 400 },
					);
				}
				try {
					const result = await enqueueDatabaseWrite((db) =>
						saveSpecialFollowPosition(parsed.data, db),
					);
					return jsonResponse(
						specialFollowPositionWriteResponseSchema.parse(result),
						{ status: result.conflict ? 409 : 200 },
					);
				} catch (error) {
					if (error instanceof SpecialFollowPositionError) {
						return jsonResponse(
							{ ok: false, message: error.message },
							{ status: error.status },
						);
					}
					throw error;
				}
			},
		},
	},
});
