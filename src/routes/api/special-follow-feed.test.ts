// @vitest-environment node
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
	insertTestAccount,
	insertTestProfile,
	insertTestTweet,
	useTestHome,
} from "#/test/test-home";
import { setProfileSpecialFollow } from "#/lib/profile-priority";
import { getRouteHandler } from "#/test/route-handlers";

vi.mock("#/lib/backup", () => ({
	maybeAutoUpdateBackupEffect: () => Effect.succeed({ skipped: true }),
}));

import { Route } from "./special-follow-feed";

const GET = getRouteHandler(Route, "GET");

describe("special-follow feed API", () => {
	const getHome = useTestHome({ prefix: "birdclaw-special-feed-route-" });

	it("returns real priority-only Home timeline items", async () => {
		const { db } = getHome();
		insertTestAccount(db, { id: "acct" });
		insertTestProfile(db, { id: "profile_user_42", handle: "ada" });
		insertTestProfile(db, { id: "profile_user_43", handle: "ordinary" });
		setProfileSpecialFollow(
			{
				handle: "ada",
				identifier: "profile_user_42",
				specialFollow: true,
			},
			db,
		);
		for (const [id, authorProfileId, createdAt] of [
			["special", "profile_user_42", "2026-08-01T02:00:00.000Z"],
			["ordinary", "profile_user_43", "2026-08-01T03:00:00.000Z"],
		] as const) {
			insertTestTweet(db, { id, authorProfileId, createdAt });
			db.prepare(
				`insert into tweet_account_edges (
				   account_id, tweet_id, kind, first_seen_at, last_seen_at,
				   seen_count, source, raw_json, updated_at
				 ) values ('acct', ?, 'home', ?, ?, 1, 'test', '{}', ?)`,
			).run(id, createdAt, createdAt, createdAt);
		}

		const response = await GET({
			request: new Request(
				"http://localhost/api/special-follow-feed?account=acct&mode=newest",
			),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			items: [{ id: "special", author: { handle: "ada" } }],
			specialFollowProfileCount: 1,
			page: { mode: "newest", restore: null },
		});
	});

	it("rejects an incomplete keyset cursor", async () => {
		const { db } = getHome();
		insertTestAccount(db, { id: "acct" });
		const response = await GET({
			request: new Request(
				"http://localhost/api/special-follow-feed?account=acct&mode=older&cursorTweetId=1",
			),
		});
		expect(response.status).toBe(400);
	});
});
