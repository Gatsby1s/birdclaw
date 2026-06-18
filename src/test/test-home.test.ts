// @vitest-environment node
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	insertTestAccount,
	insertTestDmConversation,
	insertTestDmMessage,
	insertTestProfile,
	insertTestTweet,
	withTestHome,
} from "./test-home";

describe("test home", () => {
	it("owns environment, database resets, home switches, and cleanup", async () => {
		const previousHome = process.env.BIRDCLAW_HOME;
		const previousSentinel = process.env.BIRDCLAW_TEST_SENTINEL;
		const roots: string[] = [];

		await withTestHome(async (home) => {
			process.env.BIRDCLAW_TEST_SENTINEL = "changed";
			roots.push(home.root);
			expect(process.env.BIRDCLAW_HOME).toBe(home.root);
			expect(home.paths.rootDir).toBe(home.root);
			home.db.exec("create table fixture_marker (value text)");

			home.switchHome("birdclaw-test-switched-");
			roots.push(home.root);
			expect(home.paths.rootDir).toBe(home.root);
			expect(
				home.db
					.prepare(
						"select count(*) as count from sqlite_master where name = 'fixture_marker'",
					)
					.get(),
			).toEqual({ count: 0 });
		});

		expect(process.env.BIRDCLAW_HOME).toBe(previousHome);
		expect(process.env.BIRDCLAW_TEST_SENTINEL).toBe(previousSentinel);
		for (const root of roots) expect(existsSync(root)).toBe(false);
	});

	it("cleans up when the scoped callback fails", async () => {
		let root = "";

		await expect(
			withTestHome((home) => {
				root = home.root;
				throw new Error("fixture failure");
			}),
		).rejects.toThrow("fixture failure");

		expect(existsSync(root)).toBe(false);
	});

	it("inserts canonical account, profile, tweet, and DM rows", async () => {
		await withTestHome(({ db }) => {
			insertTestAccount(db);
			insertTestProfile(db);
			insertTestTweet(db);
			insertTestDmConversation(db);
			insertTestDmMessage(db);

			expect(
				db
					.prepare(
						`select
              (select count(*) from accounts) as accounts,
              (select count(*) from profiles) as profiles,
              (select count(*) from tweets) as tweets,
              (select count(*) from dm_conversations) as conversations,
              (select count(*) from dm_messages) as messages`,
					)
					.get(),
			).toEqual({
				accounts: 1,
				profiles: 1,
				tweets: 1,
				conversations: 1,
				messages: 1,
			});
		});
	});
});
