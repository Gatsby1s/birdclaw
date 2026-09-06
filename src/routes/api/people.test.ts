// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "#/lib/config";
import { getNativeDb, resetDatabaseForTests } from "#/lib/db";
import { getRouteHandler } from "#/test/route-handlers";
import { Route } from "./people";

const GET = getRouteHandler(Route, "GET");
const POST = getRouteHandler(Route, "POST");
const roots: string[] = [];
const originalHome = process.env.BIRDCLAW_HOME;
beforeEach(() => {
	const root = mkdtempSync(path.join(os.tmpdir(), "birdclaw-people-api-"));
	roots.push(root);
	process.env.BIRDCLAW_HOME = root;
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
});
afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	if (originalHome === undefined) delete process.env.BIRDCLAW_HOME;
	else process.env.BIRDCLAW_HOME = originalHome;
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function post(input: unknown) {
	return POST({
		request: new Request(
			"https://birdclaw-production.up.railway.app/api/people",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(input),
			},
		),
	});
}

describe("people API", () => {
	it("creates a person and public source together and rolls back an invalid source", async () => {
		const invalid = await post({
			action: "create",
			name: "Invalid",
			kind: "telegram",
			url: "https://t.me/+private",
		});
		expect(invalid.status).toBe(409);
		const db = getNativeDb({ seedDemoData: false });
		expect(db.prepare("select count(*) n from people").get()).toEqual({ n: 0 });
		const created = await post({
			action: "create",
			name: "Author",
			kind: "telegram",
			url: "https://t.me/channel",
		});
		expect(created.status).toBe(200);
		const body = await created.json();
		expect(body).toMatchObject({
			ok: true,
			person: {
				name: "Author",
				sources: [
					{ kind: "telegram", identifier: "channel", historyStatus: "queued" },
				],
			},
		});
		const list = await GET({
			request: new Request(
				"https://birdclaw-production.up.railway.app/api/people",
			),
		});
		expect(await list.json()).toMatchObject({
			ok: true,
			total: 1,
			nextCursor: null,
			people: [{ id: body.person.id }],
		});
	});
	it("preserves live catchup on retry while restarting history and failed media", async () => {
		const created = await post({
			action: "create",
			name: "Author",
			kind: "telegram",
			url: "channel",
		});
		const { person } = await created.json();
		const sourceId = person.sources[0].id as string;
		const db = getNativeDb({ seedDemoData: false });
		const latest = JSON.stringify({ latest: 100, before: 120, target: 140 });
		db.prepare(
			"update person_sources set enabled=0,history_status='public_caught_up',history_cursor='50',latest_cursor=?,media_cursor=900,last_error='old error' where id=?",
		).run(latest, sourceId);
		db.prepare(
			"insert into person_assets(id,person_id,source_id,remote_url,kind,status,attempts,last_error,next_attempt_at,created_at) values('asset',?,?,?,'image','unavailable',5,'old error',?,?)",
		).run(
			person.id,
			sourceId,
			"https://cdn1.telesco.pe/file/photo.jpg",
			"2030-01-01",
			"2026-09-01",
		);
		const retried = await post({ action: "retry", sourceId });
		expect(retried.status).toBe(200);
		expect(
			db
				.prepare(
					"select enabled,history_status,history_cursor,latest_cursor,media_cursor,last_error from person_sources where id=?",
				)
				.get(sourceId),
		).toEqual({
			enabled: 1,
			history_status: "queued",
			history_cursor: null,
			latest_cursor: latest,
			media_cursor: 0,
			last_error: null,
		});
		expect(
			db
				.prepare(
					"select status,attempts,last_error from person_assets where id='asset'",
				)
				.get(),
		).toEqual({ status: "pending", attempts: 0, last_error: null });
	});
	it("rejects malformed actions without creating records", async () => {
		const response = await post({ action: "create", name: "" });
		expect(response.status).toBe(400);
		const db = getNativeDb({ seedDemoData: false });
		expect(db.prepare("select count(*) n from people").get()).toEqual({ n: 0 });
	});
});
