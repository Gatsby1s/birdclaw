import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import {
	actionRequestSchema,
	actionResponseSchemaFor,
} from "#/lib/api-contracts";
import {
	addBlockEffect,
	removeBlockEffect,
	syncBlocksEffect,
} from "#/lib/blocks";
import {
	jsonResponse,
	parseBoundedInteger,
	requestJsonEffect,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import { scoreInboxEffect } from "#/lib/inbox";
import { addMuteEffect, removeMuteEffect } from "#/lib/mutes";
import {
	createDmReplyEffect,
	createPostEffect,
	createTweetReplyEffect,
} from "#/lib/query-actions";
import type { ActionsTransport } from "#/lib/config";

function parseActionsTransport(
	value: string | undefined,
): ActionsTransport | undefined {
	return value === "auto" || value === "bird" || value === "xurl"
		? value
		: undefined;
}

function actionErrorMessage(error: unknown) {
	if (
		typeof error === "object" &&
		error !== null &&
		"cause" in error &&
		error.cause instanceof Error
	) {
		return error.cause.message;
	}
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

export const Route = createFileRoute("/api/action")({
	server: {
		handlers: {
			POST: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						const input = yield* requestJsonEffect<unknown>(request);
						const parsed = actionRequestSchema.safeParse(input);
						if (!parsed.success) {
							return jsonResponse(
								{ ok: false, message: "Unknown action kind" },
								{ status: 400 },
							);
						}
						const body = parsed.data;
						const transport = parseActionsTransport(
							"transport" in body ? body.transport : undefined,
						);
						let result: unknown;

						if (body.kind === "post") {
							result = yield* createPostEffect(
								body.accountId ?? "acct_primary",
								body.text,
							);
						} else if (body.kind === "replyTweet") {
							result = yield* createTweetReplyEffect(
								body.accountId ?? "acct_primary",
								body.tweetId,
								body.text,
							);
						} else if (body.kind === "replyDm") {
							result = yield* createDmReplyEffect(
								body.conversationId,
								body.text,
							);
						} else if (body.kind === "scoreInbox") {
							result = yield* scoreInboxEffect({
								kind: body.scoreKind,
								account: body.account,
								limit: parseBoundedInteger(body.limit, {
									defaultValue: 8,
									max: 20,
								}),
							});
						} else if (body.kind === "blockProfile") {
							result = yield* addBlockEffect(
								body.accountId ?? "acct_primary",
								body.query,
								{
									transport,
								},
							);
						} else if (body.kind === "unblockProfile") {
							result = yield* removeBlockEffect(
								body.accountId ?? "acct_primary",
								body.query,
								{
									transport,
								},
							);
						} else if (body.kind === "muteProfile") {
							result = yield* addMuteEffect(
								body.accountId ?? "acct_primary",
								body.query,
								{
									transport,
								},
							);
						} else if (body.kind === "unmuteProfile") {
							result = yield* removeMuteEffect(
								body.accountId ?? "acct_primary",
								body.query,
								{
									transport,
								},
							);
						} else if (body.kind === "syncBlocks") {
							result = yield* syncBlocksEffect(
								body.accountId ?? "acct_primary",
							);
						} else {
							return jsonResponse(
								{ ok: false, message: "Unknown action kind" },
								{ status: 400 },
							);
						}

						return jsonResponse(
							actionResponseSchemaFor(body.kind).parse(result),
						);
					}).pipe(
						Effect.catchAll((error) =>
							Effect.succeed(
								jsonResponse(
									{
										ok: false,
										message: actionErrorMessage(error),
									},
									{ status: 500 },
								),
							),
						),
					),
				),
		},
	},
});
