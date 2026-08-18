// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
	insertTestAccount,
	insertTestProfile,
	insertTestTweet,
	useTestHome,
} from "../test/test-home";
import { listProfileListFeed } from "./profile-list-feed";
import { createProfileList, setProfileListMembership } from "./profile-lists";
import type { Database } from "./sqlite";

function insertHomeEdge(db: Database, accountId: string, tweetId: string) {
	const timestamp = "2026-08-18T00:00:00.000Z";
	db.prepare(
		`insert into tweet_account_edges (
		 account_id, tweet_id, kind, first_seen_at, last_seen_at,
		 seen_count, source, raw_json, updated_at
	 ) values (?, ?, 'home', ?, ?, 1, 'test', '{}', ?)`,
	).run(accountId, tweetId, timestamp, timestamp, timestamp);
}

describe("profile List feed", () => {
	const getHome = useTestHome({ prefix: "birdclaw-profile-list-feed-" });

	it("filters Home to List members with deterministic pagination and search", () => {
		const { db } = getHome();
		insertTestAccount(db, { id: "acct" });
		insertTestProfile(db, { id: "profile_user_42", handle: "facts" });
		insertTestProfile(db, { id: "profile_user_43", handle: "noise" });
		const list = createProfileList({ accountId: "acct", name: "Facts" }, db);
		setProfileListMembership(
			{
				accountId: "acct",
				listId: list.id,
				handle: "facts",
				identifier: "profile_user_42",
				included: true,
			},
			db,
		);
		for (const [id, authorProfileId, text, hour] of [
			["fact-3", "profile_user_42", "earnings facts", "03"],
			["fact-2", "profile_user_42", "market facts", "02"],
			["fact-1", "profile_user_42", "older facts", "01"],
			["noise-4", "profile_user_43", "newest noise", "04"],
		] as const) {
			insertTestTweet(db, {
				id,
				authorProfileId,
				text,
				createdAt: `2026-08-18T${hour}:00:00.000Z`,
			});
			db.prepare("insert into tweets_fts (tweet_id, text) values (?, ?)").run(
				id,
				text,
			);
			insertHomeEdge(db, "acct", id);
		}

		const first = listProfileListFeed(
			{ accountId: "acct", listId: list.id, limit: 2 },
			db,
		);
		expect(first.items.map((item) => item.id)).toEqual(["fact-3", "fact-2"]);
		expect(first.hasMore).toBe(true);
		const cursor = first.items.at(-1)!;
		const second = listProfileListFeed(
			{
				accountId: "acct",
				listId: list.id,
				limit: 2,
				until: cursor.createdAt,
				untilId: cursor.id,
			},
			db,
		);
		expect(second.items.map((item) => item.id)).toEqual(["fact-1"]);
		expect(second.hasMore).toBe(false);
		expect(
			listProfileListFeed(
				{ accountId: "acct", listId: list.id, search: "earnings" },
				db,
			).items.map((item) => item.id),
		).toEqual(["fact-3"]);
	});

	it("returns an empty timeline when the List has no active members", () => {
		const { db } = getHome();
		insertTestAccount(db, { id: "acct" });
		const list = createProfileList({ accountId: "acct", name: "Empty" }, db);
		expect(
			listProfileListFeed({ accountId: "acct", listId: list.id }, db),
		).toMatchObject({ items: [], hasMore: false });
	});
});
