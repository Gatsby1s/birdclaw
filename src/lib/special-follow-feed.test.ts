// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
	insertTestAccount,
	insertTestProfile,
	insertTestTweet,
	useTestHome,
} from "../test/test-home";
import { setProfileSpecialFollow } from "./profile-priority";
import { listSpecialFollowFeed } from "./special-follow-feed";
import { saveSpecialFollowPosition } from "./special-follow-position";
import type { Database } from "./sqlite";

function insertHomeEdge(db: Database, accountId: string, tweetId: string) {
	db.prepare(
		`insert into tweet_account_edges (
		   account_id, tweet_id, kind, first_seen_at, last_seen_at,
		   seen_count, source, raw_json, updated_at
		 ) values (?, ?, 'home', ?, ?, 1, 'test', '{}', ?)`,
	).run(
		accountId,
		tweetId,
		"2026-08-01T00:00:00.000Z",
		"2026-08-01T00:00:00.000Z",
		"2026-08-01T00:00:00.000Z",
	);
}

function seedFeed(db: Database) {
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
	for (let index = 1; index <= 9; index += 1) {
		const id = `special_${String(index).padStart(2, "0")}`;
		insertTestTweet(db, {
			id,
			authorProfileId: "profile_user_42",
			text: id,
			createdAt: `2026-08-01T${String(index).padStart(2, "0")}:00:00.000Z`,
		});
		insertHomeEdge(db, "acct", id);
	}
	insertTestTweet(db, {
		id: "ordinary_10",
		authorProfileId: "profile_user_43",
		createdAt: "2026-08-01T10:00:00.000Z",
	});
	insertHomeEdge(db, "acct", "ordinary_10");
}

describe("special-follow feed", () => {
	const getHome = useTestHome({ prefix: "birdclaw-special-feed-" });

	it("filters Home to special follows and supports deterministic keyset pages", () => {
		const { db } = getHome();
		seedFeed(db);
		const newest = listSpecialFollowFeed(
			{ accountId: "acct", mode: "newest", limit: 3 },
			db,
		);
		expect(newest.items.map((item) => item.id)).toEqual([
			"special_09",
			"special_08",
			"special_07",
		]);
		expect(newest).toMatchObject({
			specialFollowProfileCount: 1,
			page: { hasNewer: false, hasOlder: true },
		});

		const older = listSpecialFollowFeed(
			{
				accountId: "acct",
				mode: "older",
				limit: 3,
				cursorCreatedAt: newest.page.olderCursor?.createdAt,
				cursorTweetId: newest.page.olderCursor?.tweetId,
			},
			db,
		);
		expect(older.items.map((item) => item.id)).toEqual([
			"special_06",
			"special_05",
			"special_04",
		]);

		const newer = listSpecialFollowFeed(
			{
				accountId: "acct",
				mode: "newer",
				limit: 2,
				cursorCreatedAt: older.page.newerCursor?.createdAt,
				cursorTweetId: older.page.newerCursor?.tweetId,
			},
			db,
		);
		expect(newer.items.map((item) => item.id)).toEqual([
			"special_08",
			"special_07",
		]);
	});

	it("centers the saved anchor without letting newer posts displace it", () => {
		const { db } = getHome();
		seedFeed(db);
		saveSpecialFollowPosition(
			{
				accountId: "acct",
				anchorTweetId: "special_05",
				pixelOffset: 37,
				clientSessionId: "desktop",
				clientSequence: 1,
				expectedRevision: 0,
			},
			db,
		);

		insertTestTweet(db, {
			id: "special_11",
			authorProfileId: "profile_user_42",
			createdAt: "2026-08-01T11:00:00.000Z",
		});
		insertHomeEdge(db, "acct", "special_11");

		const resumed = listSpecialFollowFeed(
			{ accountId: "acct", mode: "resume", limit: 5 },
			db,
		);
		expect(resumed.items.map((item) => item.id)).toEqual([
			"special_07",
			"special_06",
			"special_05",
			"special_04",
			"special_03",
		]);
		expect(resumed.page).toMatchObject({
			hasNewer: true,
			hasOlder: true,
			restore: {
				requestedTweetId: "special_05",
				resolvedTweetId: "special_05",
				pixelOffset: 37,
				exact: true,
			},
		});
	});

	it("falls back by timestamp when a saved anchor disappears", () => {
		const { db } = getHome();
		seedFeed(db);
		saveSpecialFollowPosition(
			{
				accountId: "acct",
				anchorTweetId: "special_05",
				pixelOffset: 9,
				clientSessionId: "phone",
				clientSequence: 1,
				expectedRevision: 0,
			},
			db,
		);
		db.prepare(
			"delete from tweet_account_edges where account_id = ? and tweet_id = ? and kind = 'home'",
		).run("acct", "special_05");

		const resumed = listSpecialFollowFeed(
			{ accountId: "acct", mode: "resume", limit: 3 },
			db,
		);
		expect(resumed.page.restore).toMatchObject({
			requestedTweetId: "special_05",
			resolvedTweetId: "special_04",
			exact: false,
			pixelOffset: 0,
		});
		expect(resumed.items.map((item) => item.id)).toEqual([
			"special_06",
			"special_04",
			"special_03",
		]);
	});

	it("isolates accounts, reused handles, and equal-time cursor boundaries", () => {
		const { db } = getHome();
		insertTestAccount(db, { id: "acct", handle: "@acct" });
		insertTestAccount(db, { id: "other", handle: "@other" });
		insertTestProfile(db, { id: "profile_handle_reused", handle: "reused" });
		db.prepare("update profiles set handle = 'old_reused' where id = ?").run(
			"profile_handle_reused",
		);
		insertTestProfile(db, { id: "profile_user_99", handle: "reused" });
		insertTestProfile(db, { id: "profile_user_42", handle: "ada" });
		setProfileSpecialFollow(
			{ handle: "reused", specialFollow: true },
			db,
			new Date("2026-08-01T00:00:00.000Z"),
		);
		setProfileSpecialFollow(
			{
				handle: "ada",
				identifier: "profile_user_42",
				specialFollow: true,
			},
			db,
		);
		for (const [id, authorProfileId, accountId] of [
			["tie_b", "profile_user_42", "acct"],
			["tie_a", "profile_user_42", "acct"],
			["other_account", "profile_user_42", "other"],
			["stable_reused", "profile_user_99", "acct"],
		] as const) {
			insertTestTweet(db, {
				id,
				authorProfileId,
				createdAt: "2026-08-01T05:00:00.000Z",
			});
			insertHomeEdge(db, accountId, id);
		}

		const first = listSpecialFollowFeed(
			{ accountId: "acct", mode: "newest", limit: 1 },
			db,
		);
		expect(first.items.map((item) => item.id)).toEqual(["tie_b"]);
		const second = listSpecialFollowFeed(
			{
				accountId: "acct",
				mode: "older",
				limit: 2,
				cursorCreatedAt: first.page.olderCursor?.createdAt,
				cursorTweetId: first.page.olderCursor?.tweetId,
			},
			db,
		);
		expect(second.items.map((item) => item.id)).toEqual(["tie_a"]);
	});
});
