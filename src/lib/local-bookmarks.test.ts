// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKUP_TABLE_CODECS } from "./backup-table-codecs";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import { setLocalBookmark } from "./local-bookmarks";

let tempRoot: string | null = null;

function setupFixture() {
	tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-local-bookmark-"));
	process.env.BIRDCLAW_HOME = tempRoot;
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
	const db = getNativeDb({ seedDemoData: false });
	db.exec(`
    insert into accounts (
      id, name, handle, transport, is_default, created_at
    ) values (
      'acct_primary', 'Primary', 'primary', 'local', 1,
      '2026-07-31T00:00:00.000Z'
    );
    insert into profiles (
      id, handle, display_name, bio, followers_count, following_count,
      avatar_hue, created_at
    ) values (
      'profile_author', 'author', 'Author', '', 0, 0, 42,
      '2026-07-31T00:00:00.000Z'
    );
    insert into tweets (
      id, author_profile_id, text, created_at, is_replied, like_count,
      media_count, entities_json, media_json
    ) values (
      'tweet_1', 'profile_author', 'Stored locally',
      '2026-07-31T00:00:00.000Z', 0, 0, 0, '{}', '[]'
    );
  `);
	return db;
}

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	if (tempRoot) {
		rmSync(tempRoot, { recursive: true, force: true });
		tempRoot = null;
	}
});

describe("local bookmarks", () => {
	it("persists and removes a bookmark in the local override table", async () => {
		const db = setupFixture();

		expect(
			await setLocalBookmark({
				accountId: "acct_primary",
				tweetId: "tweet_1",
				bookmarked: true,
			}),
		).toMatchObject({ ok: true, bookmarked: true });
		expect(
			db
				.prepare(
					"select is_bookmarked from local_tweet_bookmarks where account_id = ? and tweet_id = ?",
				)
				.get("acct_primary", "tweet_1"),
		).toEqual({ is_bookmarked: 1 });

		expect(
			await setLocalBookmark({
				accountId: "acct_primary",
				tweetId: "tweet_1",
				bookmarked: false,
			}),
		).toMatchObject({ ok: true, bookmarked: false });
		expect(
			db
				.prepare(
					"select is_bookmarked from local_tweet_bookmarks where account_id = ? and tweet_id = ?",
				)
				.get("acct_primary", "tweet_1"),
		).toEqual({ is_bookmarked: 0 });
	});

	it("does not create dangling collection rows", async () => {
		setupFixture();

		expect(
			await setLocalBookmark({
				accountId: "missing",
				tweetId: "tweet_1",
				bookmarked: true,
			}),
		).toEqual({ ok: false, reason: "account-not-found" });
		expect(
			await setLocalBookmark({
				accountId: "acct_primary",
				tweetId: "missing",
				bookmarked: true,
			}),
		).toEqual({ ok: false, reason: "tweet-not-found" });
	});

	it("keeps the newest backup state so an older device cannot resurrect a removed bookmark", () => {
		const db = setupFixture();
		const codec = BACKUP_TABLE_CODECS.find(
			(candidate) => candidate.name === "local_tweet_bookmarks",
		);
		expect(codec).toBeDefined();
		const merge = db.prepare(codec!.merge.sql);

		merge.run(
			"acct_primary",
			"tweet_1",
			0,
			"2026-07-31T00:00:00.000Z",
			"2026-07-31T02:00:00.000Z",
		);
		merge.run(
			"acct_primary",
			"tweet_1",
			1,
			"2026-07-31T00:00:00.000Z",
			"2026-07-31T01:00:00.000Z",
		);
		expect(
			db
				.prepare(
					"select is_bookmarked, updated_at from local_tweet_bookmarks where account_id = ? and tweet_id = ?",
				)
				.get("acct_primary", "tweet_1"),
		).toEqual({
			is_bookmarked: 0,
			updated_at: "2026-07-31T02:00:00.000Z",
		});

		merge.run(
			"acct_primary",
			"tweet_1",
			1,
			"2026-07-31T00:00:00.000Z",
			"2026-07-31T03:00:00.000Z",
		);
		expect(
			db
				.prepare(
					"select is_bookmarked, updated_at from local_tweet_bookmarks where account_id = ? and tweet_id = ?",
				)
				.get("acct_primary", "tweet_1"),
		).toEqual({
			is_bookmarked: 1,
			updated_at: "2026-07-31T03:00:00.000Z",
		});
	});
});
