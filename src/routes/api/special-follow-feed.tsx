import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { z } from "zod";
import { specialFollowFeedResponseSchema } from "#/lib/api-contracts";
import { maybeAutoUpdateBackupEffect } from "#/lib/backup";
import {
	jsonResponse,
	parseBoundedInteger,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import { listSpecialFollowFeed } from "#/lib/special-follow-feed";
import { specialFollowAccountExists } from "#/lib/special-follow-position";

const modeSchema = z.enum(["newest", "resume", "newer", "older"]);

export const Route = createFileRoute("/api/special-follow-feed")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;
						yield* maybeAutoUpdateBackupEffect();
						const url = new URL(request.url);
						const accountId = url.searchParams.get("account")?.trim() ?? "";
						if (!accountId || !specialFollowAccountExists(accountId)) {
							return jsonResponse(
								{ ok: false, message: "BirdClaw account not found." },
								{ status: 404 },
							);
						}
						const parsedMode = modeSchema.safeParse(
							url.searchParams.get("mode") ?? "resume",
						);
						if (!parsedMode.success) {
							return jsonResponse(
								{ ok: false, message: "Choose a valid feed mode." },
								{ status: 400 },
							);
						}
						const cursorCreatedAt =
							url.searchParams.get("cursorCreatedAt")?.trim() || undefined;
						const cursorTweetId =
							url.searchParams.get("cursorTweetId")?.trim() || undefined;
						if (
							(parsedMode.data === "newer" || parsedMode.data === "older") &&
							(!cursorCreatedAt ||
								!cursorTweetId ||
								!Number.isFinite(Date.parse(cursorCreatedAt)))
						) {
							return jsonResponse(
								{
									ok: false,
									message: "A complete valid feed cursor is required.",
								},
								{ status: 400 },
							);
						}
						return jsonResponse(
							specialFollowFeedResponseSchema.parse(
								listSpecialFollowFeed({
									accountId,
									mode: parsedMode.data,
									limit: parseBoundedInteger(url.searchParams.get("limit"), {
										defaultValue: 18,
										min: 1,
										max: 50,
									}),
									...(cursorCreatedAt ? { cursorCreatedAt } : {}),
									...(cursorTweetId ? { cursorTweetId } : {}),
								}),
							),
						);
					}),
				),
		},
	},
});
