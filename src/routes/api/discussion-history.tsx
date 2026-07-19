import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import {
	deleteDiscussionHistory,
	getDiscussionHistory,
	listDiscussionHistory,
	updateDiscussionHistory,
} from "#/lib/discussion-history";
import {
	jsonResponse,
	parseBoundedInteger,
	requestJsonEffect,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";

function historyId(request: Request) {
	return new URL(request.url).searchParams.get("id")?.trim() || null;
}

function deniedResponse(request: Request) {
	return sensitiveRequestErrorResponse(request);
}

export const Route = createFileRoute("/api/discussion-history")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.sync(() => {
						const denied = deniedResponse(request);
						if (denied) return denied;
						const url = new URL(request.url);
						const id = historyId(request);
						if (id) {
							const item = getDiscussionHistory(id);
							return item
								? jsonResponse({ item })
								: jsonResponse(
										{ ok: false, message: "Discussion history not found" },
										{ status: 404 },
									);
						}
						const limit = parseBoundedInteger(url.searchParams.get("limit"), {
							defaultValue: 50,
							max: 200,
						});
						return jsonResponse({
							items: listDiscussionHistory({ limit }),
						});
					}),
				),
			DELETE: ({ request }) =>
				runRouteEffect(
					Effect.sync(() => {
						const denied = deniedResponse(request);
						if (denied) return denied;
						const id = historyId(request);
						if (!id) {
							return jsonResponse(
								{ ok: false, message: "Discussion history id is required" },
								{ status: 400 },
							);
						}
						return deleteDiscussionHistory(id)
							? jsonResponse({ ok: true })
							: jsonResponse(
									{ ok: false, message: "Discussion history not found" },
									{ status: 404 },
								);
					}),
				),
			PATCH: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = deniedResponse(request);
						if (denied) return denied;
						const body = yield* requestJsonEffect<Record<string, unknown>>(
							request,
							{},
						);
						const id =
							historyId(request) ??
							(typeof body.id === "string" ? body.id.trim() : "");
						if (!id) {
							return jsonResponse(
								{ ok: false, message: "Discussion history id is required" },
								{ status: 400 },
							);
						}
						const title =
							typeof body.title === "string"
								? body.title.trim().slice(0, 200)
								: undefined;
						const pinned =
							typeof body.pinned === "boolean" ? body.pinned : undefined;
						if (title === undefined && pinned === undefined) {
							return jsonResponse(
								{ ok: false, message: "No supported history changes supplied" },
								{ status: 400 },
							);
						}
						if (body.title !== undefined && !title) {
							return jsonResponse(
								{ ok: false, message: "Discussion history title is required" },
								{ status: 400 },
							);
						}
						const item = updateDiscussionHistory(id, { title, pinned });
						return item
							? jsonResponse({ item })
							: jsonResponse(
									{ ok: false, message: "Discussion history not found" },
									{ status: 404 },
								);
					}),
				),
		},
	},
});
