import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { getNativeDb } from "#/lib/db";
import { jsonResponse, sensitiveRequestErrorResponse } from "#/lib/http-effect";
import {
	addPersonSource,
	createPerson,
	getPersonDetail,
	listPeoplePage,
	mergePeople,
	markPersonRead,
	requirePerson,
	resolvePersonForHandle,
	type PersonSourceRow,
} from "#/lib/person-archive-store";
import { readBoundedPersonBody } from "#/lib/person-archive-files";
const id = z.string().uuid();
const actionSchema = z.discriminatedUnion("action", [
	z.object({
		action: z.literal("create"),
		name: z.string().trim().min(1).max(120),
		description: z.string().max(4000).optional(),
		kind: z.enum(["x", "telegram"]).optional(),
		url: z.string().max(2048).optional(),
	}),
	z.object({
		action: z.literal("update"),
		personId: id,
		name: z.string().trim().min(1).max(120),
		description: z.string().max(4000),
	}),
	z.object({
		action: z.literal("addSource"),
		personId: id,
		kind: z.enum(["x", "telegram"]),
		url: z.string().min(1).max(2048),
	}),
	z.object({
		action: z.literal("sourceState"),
		sourceId: id,
		enabled: z.boolean(),
	}),
	z.object({ action: z.literal("retry"), sourceId: id }),
	z.object({ action: z.literal("merge"), personId: id, targetPersonId: id }),
	z.object({
		action: z.literal("read"),
		personId: id,
		throughSequence: z.number().int().nonnegative(),
	}),
	z.object({
		action: z.literal("resolve"),
		handle: z.string().min(1).max(2048),
	}),
]);
export const Route = createFileRoute("/api/people")({
	server: {
		handlers: {
			GET: ({ request }) => {
				const denied = sensitiveRequestErrorResponse(request);
				if (denied) return denied;
				const db = getNativeDb({ seedDemoData: false });
				const params = new URL(request.url).searchParams;
				try {
					return jsonResponse({
						ok: true,
						...(params.get("personId")
							? { person: getPersonDetail(db, params.get("personId")!) }
							: listPeoplePage(db, {
									q: params.get("q")?.slice(0, 500),
									handle: params.get("handle") ?? undefined,
									before: params.get("before") ?? undefined,
									unread: params.get("unread") === "1",
								})),
					});
				} catch {
					return jsonResponse(
						{ ok: false, message: "人物不存在。" },
						{ status: 404 },
					);
				}
			},
			POST: async ({ request }) => {
				const denied = sensitiveRequestErrorResponse(request);
				if (denied) return denied;
				const db = getNativeDb({ seedDemoData: false });
				try {
					const parsed = actionSchema.safeParse(
						JSON.parse(
							(await readBoundedPersonBody(request, 16 * 1024)).toString(
								"utf8",
							),
						),
					);
					if (!parsed.success)
						return jsonResponse(
							{ ok: false, message: "人物操作参数无效。" },
							{ status: 400 },
						);
					const input = parsed.data;
					let personId = "";
					db.transaction(() => {
						if (input.action === "create") {
							personId = createPerson(db, input.name, input.description);
							if (input.url) {
								if (!input.kind) throw new Error("请选择来源平台。");
								addPersonSource(db, personId, input.kind, input.url);
							}
						} else if (input.action === "resolve") {
							personId = resolvePersonForHandle(db, input.handle);
						} else if (input.action === "update") {
							personId = input.personId;
							requirePerson(db, personId);
							db.prepare(
								"update people set name=?,description=?,updated_at=? where id=?",
							).run(
								input.name,
								input.description,
								new Date().toISOString(),
								personId,
							);
						} else if (input.action === "addSource") {
							personId = input.personId;
							addPersonSource(db, personId, input.kind, input.url);
						} else if (input.action === "merge") {
							personId = mergePeople(db, input.personId, input.targetPersonId);
						} else if (input.action === "read") {
							personId = input.personId;
							markPersonRead(db, personId, input.throughSequence);
						} else {
							const source = db
								.prepare("select * from person_sources where id=?")
								.get(input.sourceId) as PersonSourceRow | undefined;
							if (!source) throw new Error("来源不存在。");
							personId = source.person_id;
							if (input.action === "sourceState")
								db.prepare(
									"update person_sources set enabled=?,next_poll_at=? where id=?",
								).run(
									input.enabled ? 1 : 0,
									new Date().toISOString(),
									source.id,
								);
							else {
								db.prepare(
									"update person_sources set enabled=1,history_status='queued',history_cursor=null,media_cursor=0,last_error=null,next_poll_at=? where id=?",
								).run(new Date().toISOString(), source.id);
								if (source.kind === "x" && source.profile_id)
									db.prepare(
										"update twillot_history_jobs set state='queued',capture_status='capture_requested',cursor_json='null',next_run_at=?,lease_token=null,lease_expires_at=null,last_error=null,completed_at=null where profile_id=? and state in ('completed','failed')",
									).run(new Date().toISOString(), source.profile_id);
								db.prepare(
									"update person_assets set status='pending',attempts=0,last_error=null,next_attempt_at=? where source_id=? and status in ('failed','deferred','retry','unavailable')",
								).run(new Date().toISOString(), source.id);
							}
						}
					})();
					return jsonResponse({
						ok: true,
						person: getPersonDetail(db, personId),
					});
				} catch (error) {
					return jsonResponse(
						{
							ok: false,
							message:
								error instanceof Error ? error.message : "人物操作失败。",
						},
						{ status: 409 },
					);
				}
			},
		},
	},
});
