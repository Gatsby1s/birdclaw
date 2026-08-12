// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
	insertTestAccount,
	insertTestProfile,
	insertTestTweet,
	useTestHome,
} from "../test/test-home";
import { setProfileSpecialFollow } from "./profile-priority";
import {
	getSpecialFollowPosition,
	saveSpecialFollowPosition,
	SpecialFollowPositionError,
} from "./special-follow-position";
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

describe("special-follow reading position", () => {
	const getHome = useTestHome({ prefix: "birdclaw-special-position-" });

	it("persists a server-validated anchor and rejects stale device races", () => {
		const { db } = getHome();
		insertTestAccount(db, { id: "acct" });
		insertTestProfile(db, { id: "profile_user_42", handle: "ada" });
		insertTestTweet(db, {
			id: "tweet_1",
			authorProfileId: "profile_user_42",
			createdAt: "2026-08-01T01:00:00.000Z",
		});
		insertHomeEdge(db, "acct", "tweet_1");
		setProfileSpecialFollow(
			{
				handle: "ada",
				identifier: "profile_user_42",
				specialFollow: true,
			},
			db,
		);

		const first = saveSpecialFollowPosition(
			{
				accountId: "acct",
				anchorTweetId: "tweet_1",
				pixelOffset: 9000,
				clientSessionId: "desktop",
				clientSequence: 1,
				expectedRevision: 0,
			},
			db,
			new Date("2026-08-01T02:00:00.000Z"),
		);
		expect(first).toMatchObject({
			applied: true,
			position: {
				anchorCreatedAt: "2026-08-01T01:00:00.000Z",
				pixelOffset: 4096,
				revision: 1,
			},
		});

		const staleSameSession = saveSpecialFollowPosition(
			{
				accountId: "acct",
				anchorTweetId: "tweet_1",
				pixelOffset: 1,
				clientSessionId: "desktop",
				clientSequence: 1,
				expectedRevision: 1,
			},
			db,
		);
		expect(staleSameSession).toMatchObject({ applied: false });

		const newerSameSession = saveSpecialFollowPosition(
			{
				accountId: "acct",
				anchorTweetId: "tweet_1",
				pixelOffset: 12,
				clientSessionId: "desktop",
				clientSequence: 2,
				expectedRevision: 0,
			},
			db,
		);
		expect(newerSameSession).toMatchObject({
			applied: true,
			position: { revision: 2 },
		});

		const stalePhone = saveSpecialFollowPosition(
			{
				accountId: "acct",
				anchorTweetId: "tweet_1",
				pixelOffset: 30,
				clientSessionId: "phone",
				clientSequence: 1,
				expectedRevision: 1,
			},
			db,
		);
		expect(stalePhone).toMatchObject({
			ok: false,
			applied: false,
			conflict: true,
			position: { revision: 2, clientSessionId: "desktop" },
		});

		const phone = saveSpecialFollowPosition(
			{
				accountId: "acct",
				anchorTweetId: "tweet_1",
				pixelOffset: -20,
				clientSessionId: "phone",
				clientSequence: 1,
				expectedRevision: 2,
			},
			db,
		);
		expect(phone).toMatchObject({
			applied: true,
			position: { revision: 3, clientSessionId: "phone" },
		});
		expect(getSpecialFollowPosition("acct", db)).toEqual(
			expect.objectContaining({ position: phone.position }),
		);
	});

	it("rejects anchors outside the account Home special-follow edge", () => {
		const { db } = getHome();
		insertTestAccount(db, { id: "acct" });
		insertTestProfile(db, { id: "profile_user_43", handle: "ordinary" });
		insertTestTweet(db, {
			id: "tweet_ordinary",
			authorProfileId: "profile_user_43",
		});
		insertHomeEdge(db, "acct", "tweet_ordinary");

		expect(() =>
			saveSpecialFollowPosition(
				{
					accountId: "acct",
					anchorTweetId: "tweet_ordinary",
					pixelOffset: 0,
					clientSessionId: "desktop",
					clientSequence: 1,
					expectedRevision: 0,
				},
				db,
			),
		).toThrow(SpecialFollowPositionError);
	});
});
