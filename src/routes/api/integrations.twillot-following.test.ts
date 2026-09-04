// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "#/lib/config";
import { getNativeDb, resetDatabaseForTests } from "#/lib/db";
import { createTwillotCompanionPairing } from "#/lib/twillot-companion";
import { getRouteHandler } from "#/test/route-handlers";
import {
	Route,
	TWILLOT_FOLLOWING_EXTENSION_ORIGIN,
} from "./integrations.twillot-following";

const POST = getRouteHandler(Route, "POST");
let tempRoot = "";

beforeEach(() => {
	tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-twillot-following-"));
	process.env.BIRDCLAW_HOME = tempRoot;
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
});

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	rmSync(tempRoot, { recursive: true, force: true });
});

function setup() {
	const db = getNativeDb({ seedDemoData: false });
	db.prepare(
		`insert into accounts (
		   id, name, handle, external_user_id, transport, is_default, created_at
		 ) values ('acct', 'Owner', 'owner', '1', 'xurl', 1, ?)`,
	).run("2026-09-04T00:00:00.000Z");
	return { db, token: createTwillotCompanionPairing(db).token };
}

function request(token: string, users: unknown[]) {
	return new Request(
		"http://127.0.0.1:3001/api/integrations/twillot-following",
		{
			method: "POST",
			headers: {
				origin: TWILLOT_FOLLOWING_EXTENSION_ORIGIN,
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				action: "following_snapshot",
				users,
				pageCount: 1,
				complete: true,
			}),
		},
	);
}

describe("Twillot cloud following snapshot API", () => {
	it("imports a complete following list as cloud collection targets", async () => {
		const { db, token } = setup();
		const response = await POST({
			request: request(token, [
				{ id: "42", username: "alice", name: "Alice" },
				{ id: "43", username: "bob", name: "Bob" },
			]),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			result: { status: "complete", count: 2 },
		});
		expect(
			db
				.prepare(
					`select p.handle
					 from follow_edges e join profiles p on p.id = e.profile_id
					 where e.current = 1 order by p.handle`,
				)
				.all(),
		).toEqual([{ handle: "alice" }, { handle: "bob" }]);
	});

	it("requires the exact extension origin, token, and a complete snapshot", async () => {
		const { token } = setup();
		const wrongOrigin = request(token, [
			{ id: "42", username: "alice", name: "Alice" },
		]);
		wrongOrigin.headers.set(
			"origin",
			"chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		);
		expect(await POST({ request: wrongOrigin })).toMatchObject({ status: 403 });

		const incomplete = request(token, [
			{ id: "42", username: "alice", name: "Alice" },
		]);
		const body = await incomplete.json();
		body.complete = false;
		expect(
			await POST({
				request: new Request(incomplete.url, {
					method: "POST",
					headers: incomplete.headers,
					body: JSON.stringify(body),
				}),
			}),
		).toMatchObject({ status: 400 });
	});
});
