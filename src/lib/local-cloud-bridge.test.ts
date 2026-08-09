// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
	insertTestAccount,
	insertTestProfile,
	insertTestTweet,
	useTestHome,
} from "../test/test-home";
import {
	buildLocalCloudBridgeBatch,
	importLocalCloudBridgeBatch,
	LocalCloudBridgeClient,
	verifyLocalCloudBridgeToken,
} from "./local-cloud-bridge";
import { listTimelineItems } from "./timeline-read-model";

describe("local cloud bridge", () => {
	const getHome = useTestHome({ prefix: "birdclaw-local-cloud-bridge-" });

	it("copies timeline rows idempotently into the cloud database", async () => {
		const home = getHome();
		insertTestAccount(home.db);
		insertTestProfile(home.db);
		insertTestTweet(home.db, {
			text: "local bridge tweet",
			mediaJson: '[{"type":"photo","url":"https://example.com/photo.jpg"}]',
		});
		home.db
			.prepare(
				`insert into xremark_profile_notes (
					identifier, additional_name, given_name, remark, description,
					tags_json, category_name, source_updated_at, imported_at
				) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				"profile:test",
				"test",
				"Test Profile",
				"Do not follow directly",
				"Followed as a reverse indicator",
				JSON.stringify(["反指"]),
				"风险观察",
				1_752_499_700_000,
				"2026-07-31T08:00:00.000Z",
			);
		home.db
			.prepare(
				`insert into birdclaw_profile_priorities (
				 priority_key, identifier, additional_name, is_special_follow, updated_at
				) values (?, ?, ?, ?, ?)`,
			)
			.run(
				"id:profile:test",
				"profile:test",
				"test",
				1,
				"2026-07-31T08:00:00.000Z",
			);
		home.db
			.prepare(
				`insert into xremark_import_state (
					id, backup_id, backup_time, source_version, imported_at,
					annotation_count
				) values (1, ?, ?, ?, ?, ?)`,
			)
			.run("backup:test", 1_752_499_800_000, 1, "2026-07-31T08:00:00.000Z", 1);
		home.db
			.prepare(
				`
				insert into tweet_account_edges (
					account_id, tweet_id, kind, first_seen_at, last_seen_at,
					seen_count, source, raw_json, updated_at
				) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
				`,
			)
			.run(
				"account:test",
				"tweet:test",
				"home",
				"2026-07-31T08:00:00.000Z",
				"2026-07-31T08:00:00.000Z",
				1,
				"bird",
				'{"id":"tweet:test"}',
				"2026-07-31T08:00:00.000Z",
			);

		const batch = buildLocalCloudBridgeBatch({
			cursor: {
				updatedAt: "2026-07-31T07:59:00.000Z",
				accountId: "",
				tweetId: "",
				kind: "",
			},
			now: new Date("2026-07-31T08:01:00.000Z"),
			db: home.db,
		});
		expect(batch.homeTimelineSyncedAt).toBeNull();
		expect(batch.edges).toHaveLength(1);
		expect(batch.tweets[0]).toMatchObject({
			id: "tweet:test",
			text: "local bridge tweet",
		});
		expect(batch.profiles[0]).toMatchObject({ id: "profile:test" });
		expect(batch.xRemarkSnapshot).toMatchObject({
			backupId: "backup:test",
			annotations: [
				{
					identifier: "profile:test",
					tags: ["反指"],
					remark: "Do not follow directly",
					description: "Followed as a reverse indicator",
				},
			],
		});
		expect(batch.profilePriorities).toEqual([
			{
				priorityKey: "id:profile:test",
				identifier: "profile:test",
				additionalName: "test",
				isSpecialFollow: 1,
				updatedAt: "2026-07-31T08:00:00.000Z",
			},
		]);

		home.switchHome();
		home.db
			.prepare(
				`insert into birdclaw_profile_notes (
					note_key, identifier, additional_name, remark, description, updated_at
				) values (?, ?, ?, ?, ?, ?)`,
			)
			.run(
				"id:profile:test",
				"profile:test",
				"test",
				"Edited from the mobile profile",
				"Edited mobile description",
				"2026-07-31T08:00:30.000Z",
			);
		home.db
			.prepare(
				`insert into birdclaw_profile_priorities (
				 priority_key, identifier, additional_name, is_special_follow, updated_at
				) values (?, ?, ?, ?, ?)`,
			)
			.run(
				"id:profile:test",
				"profile:test",
				"test",
				0,
				"2026-07-31T08:01:00.000Z",
			);
		const imported = await importLocalCloudBridgeBatch(batch);
		await importLocalCloudBridgeBatch(batch);
		expect(imported.profilePriorities).toEqual([
			expect.objectContaining({
				priorityKey: "id:profile:test",
				isSpecialFollow: 0,
			}),
		]);

		expect(
			home.db.prepare("select count(*) as count from tweets").get(),
		).toEqual({ count: 1 });
		expect(
			home.db
				.prepare(
					"select seen_count, source from tweet_account_edges where tweet_id = ?",
				)
				.get("tweet:test"),
		).toEqual({ seen_count: 1, source: "bird" });
		expect(
			home.db
				.prepare("select count(*) as count from tweets_fts where tweet_id = ?")
				.get("tweet:test"),
		).toEqual({ count: 1 });
		expect(
			home.db
				.prepare(
					"select tags_json as tagsJson, remark, description from xremark_profile_notes where identifier = ?",
				)
				.get("profile:test"),
		).toEqual({
			tagsJson: JSON.stringify(["反指"]),
			remark: "Do not follow directly",
			description: "Followed as a reverse indicator",
		});
		await importLocalCloudBridgeBatch({
			...batch,
			xRemarkSnapshot: batch.xRemarkSnapshot
				? { ...batch.xRemarkSnapshot, annotations: [] }
				: null,
		});
		expect(
			home.db
				.prepare("select count(*) as count from xremark_profile_notes")
				.get(),
		).toEqual({ count: 0 });
		expect(
			home.db
				.prepare(
					"select remark, description from birdclaw_profile_notes where note_key = ?",
				)
				.get("id:profile:test"),
		).toEqual({
			remark: "Edited from the mobile profile",
			description: "Edited mobile description",
		});
	});

	it("ships native X bookmarks to cloud and returns newer local bookmark state", async () => {
		const home = getHome();
		insertTestAccount(home.db);
		insertTestProfile(home.db);
		insertTestTweet(home.db, { text: "saved on X" });
		home.db
			.prepare(
				`insert into tweet_collections (
					account_id, tweet_id, kind, collected_at, source, raw_json, updated_at
				) values (?, ?, 'bookmarks', ?, 'xurl', '{}', ?)`,
			)
			.run(
				"account:test",
				"tweet:test",
				"2026-08-03T08:00:00.000Z",
				"2026-08-03T08:00:00.000Z",
			);
		home.db
			.prepare(
				`insert into local_tweet_bookmarks (
					account_id, tweet_id, is_bookmarked, created_at, updated_at
				) values (?, ?, 1, ?, ?)`,
			)
			.run(
				"account:test",
				"tweet:test",
				"2026-08-03T08:00:00.000Z",
				"2026-08-03T08:00:00.000Z",
			);

		const batch = buildLocalCloudBridgeBatch({
			accountId: "account:test",
			purpose: "bookmarks",
			cursor: {
				updatedAt: "2026-08-03T09:00:00.000Z",
				accountId: "",
				tweetId: "",
				kind: "",
			},
			db: home.db,
		});
		expect(batch).toMatchObject({
			caughtUp: true,
			edges: [],
			localBookmarks: [
				{ accountId: "account:test", tweetId: "tweet:test", isBookmarked: 1 },
			],
			nativeBookmarks: [
				{ accountId: "account:test", tweetId: "tweet:test", source: "xurl" },
			],
		});
		expect(batch.tweets.map((tweet) => tweet.id)).toEqual(["tweet:test"]);

		home.switchHome();
		await importLocalCloudBridgeBatch(batch);
		expect(
			home.db
				.prepare(
					"select source from tweet_collections where account_id = ? and tweet_id = ? and kind = 'bookmarks'",
				)
				.get("account:test", "tweet:test"),
		).toEqual({ source: "xurl" });
		home.db
			.prepare(
				`update local_tweet_bookmarks
				 set is_bookmarked = 0, updated_at = ?
				 where account_id = ? and tweet_id = ?`,
			)
			.run("2026-08-03T09:00:00.000Z", "account:test", "tweet:test");

		const merged = await importLocalCloudBridgeBatch(batch);
		expect(merged.localBookmarks).toEqual([
			{
				accountId: "account:test",
				tweetId: "tweet:test",
				isBookmarked: 0,
				createdAt: "2026-08-03T08:00:00.000Z",
				updatedAt: "2026-08-03T09:00:00.000Z",
			},
		]);
	});

	it("hydrates a cloud-only local bookmark into the Mac bookmark view", async () => {
		const home = getHome();
		insertTestAccount(home.db);
		insertTestProfile(home.db, {
			id: "profile:cloud",
			handle: "cloud_author",
			displayName: "Cloud Author",
			avatarUrl: "https://example.com/cloud-author.jpg",
		});
		insertTestProfile(home.db, {
			id: "profile:quote",
			handle: "quoted_author",
			displayName: "Quoted Author",
			avatarUrl: "https://example.com/quoted-author.jpg",
		});
		insertTestTweet(home.db, {
			id: "tweet:quote",
			authorProfileId: "profile:quote",
			text: "Quoted from the cloud",
		});
		insertTestTweet(home.db, {
			id: "tweet:cloud-only",
			authorProfileId: "profile:cloud",
			text: "Bookmarked only in the cloud",
			quotedTweetId: "tweet:quote",
		});
		home.db
			.prepare(
				`insert into local_tweet_bookmarks (
					account_id, tweet_id, is_bookmarked, created_at, updated_at
				) values (?, ?, 1, ?, ?)`,
			)
			.run(
				"account:test",
				"tweet:cloud-only",
				"2026-08-03T08:00:00.000Z",
				"2026-08-03T08:00:00.000Z",
			);

		const cloudResponse = await importLocalCloudBridgeBatch(
			buildLocalCloudBridgeBatch({
				purpose: "bookmarks",
				accountId: "account:test",
				db: home.db,
			}),
		);
		expect(cloudResponse).toMatchObject({
			bookmarkSyncVersion: 1,
			bookmarkProfiles: expect.arrayContaining([
				expect.objectContaining({ id: "profile:cloud" }),
				expect.objectContaining({ id: "profile:quote" }),
			]),
			bookmarkTweets: expect.arrayContaining([
				expect.objectContaining({ id: "tweet:cloud-only" }),
				expect.objectContaining({ id: "tweet:quote" }),
			]),
		});

		home.switchHome();
		insertTestAccount(home.db);
		const client = new LocalCloudBridgeClient({
			url: "http://127.0.0.1:3000",
			token: "bridge-secret",
			accountId: "account:test",
			fetchImpl: vi.fn(async (_url, init) => {
				const request = JSON.parse(String(init?.body)) as { purpose: string };
				return Response.json(
					request.purpose === "bookmarks" ? cloudResponse : { ok: true },
				);
			}),
		});

		await client.runOnce();
		await client.runOnce();

		const items = listTimelineItems({
			resource: "home",
			bookmarkedOnly: true,
			limit: 10,
		});
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			id: "tweet:cloud-only",
			text: "Bookmarked only in the cloud",
			author: {
				id: "profile:cloud",
				handle: "cloud_author",
				avatarUrl: "https://example.com/cloud-author.jpg",
			},
			quotedTweet: {
				id: "tweet:quote",
				text: "Quoted from the cloud",
				author: {
					id: "profile:quote",
					handle: "quoted_author",
					avatarUrl: "https://example.com/quoted-author.jpg",
				},
			},
		});
		expect(
			home.db.prepare("select count(*) as count from profiles").get(),
		).toEqual({ count: 2 });
		expect(
			home.db.prepare("select count(*) as count from tweets").get(),
		).toEqual({
			count: 2,
		});
		expect(
			home.db.prepare("select count(*) as count from tweets_fts").get(),
		).toEqual({ count: 2 });
		expect(
			home.db
				.prepare("select count(*) as count from local_tweet_bookmarks")
				.get(),
		).toEqual({ count: 1 });
	});

	it("paginates large bookmark hydration responses below the safe byte budget", async () => {
		const home = getHome();
		insertTestAccount(home.db);
		insertTestProfile(home.db);
		const oversizedMediaJson = JSON.stringify([
			{ type: "photo", url: `https://example.com/${"x".repeat(900_000)}` },
		]);
		for (let index = 0; index < 8; index += 1) {
			const tweetId = `tweet:large-hydration:${String(index)}`;
			const updatedAt = `2026-08-03T08:00:0${String(index)}.000Z`;
			insertTestTweet(home.db, {
				id: tweetId,
				text: `Large bookmark ${String(index)}`,
				mediaCount: 1,
				mediaJson: oversizedMediaJson,
			});
			home.db
				.prepare(
					`insert into local_tweet_bookmarks (
						account_id, tweet_id, is_bookmarked, created_at, updated_at
					) values (?, ?, 1, ?, ?)`,
				)
				.run("account:test", tweetId, updatedAt, updatedAt);
		}

		const makeRequest = (cloudCursor?: {
			updatedAt: string;
			accountId: string;
			tweetId: string;
		}) =>
			buildLocalCloudBridgeBatch({
				purpose: "bookmarks",
				accountId: "account:test",
				limit: 8,
				cursor: {
					updatedAt: "2099-01-01T00:00:00.000Z",
					accountId: "",
					tweetId: "",
					kind: "",
					bookmarkSourceAccountId: "account:test",
					localBookmarkUpdatedAt: "2099-01-01T00:00:00.000Z",
					localBookmarkAccountId: "account:test",
					localBookmarkTweetId: "",
					cloudBookmarkUpdatedAt: cloudCursor?.updatedAt ?? "",
					cloudBookmarkAccountId: cloudCursor?.accountId ?? "",
					cloudBookmarkTweetId: cloudCursor?.tweetId ?? "",
				},
				db: home.db,
			});

		const first = await importLocalCloudBridgeBatch(makeRequest());
		expect(first.localBookmarks).toHaveLength(4);
		expect(first.localBookmarksCaughtUp).toBe(false);
		expect(
			Buffer.byteLength(
				JSON.stringify({
					localBookmarks: first.localBookmarks,
					bookmarkProfiles: first.bookmarkProfiles,
					bookmarkTweets: first.bookmarkTweets,
				}),
			),
		).toBeLessThanOrEqual(6 * 1024 * 1024);

		const second = await importLocalCloudBridgeBatch(
			makeRequest(first.localBookmarkCursor),
		);
		expect(second.localBookmarks).toHaveLength(4);
		expect(second.localBookmarksCaughtUp).toBe(true);
		expect([
			...(first.localBookmarks ?? []),
			...(second.localBookmarks ?? []),
		]).toHaveLength(8);
	});

	it("replays advanced cloud bookmark cursors only after hydration capability is available", async () => {
		const home = getHome();
		insertTestAccount(home.db);
		const localTimestamp = "2026-08-03T07:00:00.000Z";
		const timestampOne = "2026-08-03T08:00:00.000Z";
		const timestampTwo = "2026-08-03T09:00:00.000Z";
		const timestampThree = "2026-08-03T10:00:00.000Z";
		const profile = (id: string, handle: string) => ({
			id,
			handle,
			displayName: handle,
			bio: "",
			followersCount: 0,
			followingCount: 0,
			publicMetricsJson: "{}",
			avatarHue: 1,
			avatarUrl: null,
			location: null,
			url: null,
			verifiedType: null,
			entitiesJson: "{}",
			rawJson: "{}",
			createdAt: timestampOne,
		});
		const tweet = (id: string, authorProfileId: string, text: string) => ({
			id,
			authorProfileId,
			text,
			createdAt: timestampOne,
			isReplied: 0,
			replyToId: null,
			likeCount: 0,
			mediaCount: 0,
			entitiesJson: "{}",
			mediaJson: "[]",
			quotedTweetId: null,
		});
		const bookmark = (tweetId: string, updatedAt: string) => ({
			accountId: "account:test",
			tweetId,
			isBookmarked: 1,
			createdAt: updatedAt,
			updatedAt,
		});
		const profileOne = profile("profile:one", "one");
		const profileTwo = profile("profile:two", "two");
		const tweetOne = tweet("tweet:one", profileOne.id, "First cloud bookmark");
		const tweetTwo = tweet("tweet:two", profileTwo.id, "Second cloud bookmark");
		const profileThree = profile("profile:three", "three");
		const tweetThree = tweet(
			"tweet:three",
			profileThree.id,
			"Third cloud bookmark",
		);
		const cloudPage = ({
			rows,
			profiles,
			tweets,
			updatedAt,
			caughtUp,
			capability = true,
		}: {
			rows: Array<ReturnType<typeof bookmark>>;
			profiles: Array<ReturnType<typeof profile>>;
			tweets: Array<ReturnType<typeof tweet>>;
			updatedAt: string;
			caughtUp: boolean;
			capability?: boolean;
		}) => ({
			ok: true,
			bookmarkSyncVersion: 1,
			...(capability ? { bookmarkHydrationVersion: 1 } : {}),
			localBookmarks: rows,
			...(capability
				? { bookmarkProfiles: profiles, bookmarkTweets: tweets }
				: {}),
			localBookmarkCursor: {
				updatedAt,
				accountId: updatedAt ? "account:test" : "",
				tweetId:
					rows.at(-1)?.tweetId ??
					(updatedAt === timestampThree
						? tweetThree.id
						: updatedAt
							? tweetTwo.id
							: ""),
			},
			localBookmarksCaughtUp: caughtUp,
		});
		insertTestProfile(home.db, { id: "profile:seed", handle: "seed" });
		insertTestTweet(home.db, {
			id: "tweet:seed",
			authorProfileId: "profile:seed",
		});
		home.db
			.prepare(
				`insert into local_tweet_bookmarks (
					account_id, tweet_id, is_bookmarked, created_at, updated_at
				) values ('account:test', 'tweet:seed', 1, ?, ?)`,
			)
			.run(localTimestamp, localTimestamp);
		home.db
			.prepare(
				`insert into tweet_collections (
					account_id, tweet_id, kind, collected_at, source, raw_json, updated_at
				) values ('account:test', 'tweet:seed', 'bookmarks', ?, 'test', '{}', ?)`,
			)
			.run(localTimestamp, localTimestamp);
		const oldCloudClient = new LocalCloudBridgeClient({
			url: "http://127.0.0.1:3000",
			token: "bridge-secret",
			accountId: "account:test",
			batchSize: 1,
			fetchImpl: vi.fn(async (_url, init) => {
				const request = JSON.parse(String(init?.body)) as { purpose: string };
				return Response.json(
					request.purpose === "bookmarks"
						? cloudPage({
								rows: [],
								profiles: [],
								tweets: [],
								updatedAt: timestampTwo,
								caughtUp: true,
								capability: false,
							})
						: { ok: true },
				);
			}),
		});

		await oldCloudClient.runOnce();
		const cursorRow = () =>
			home.db
				.prepare(
					"select value_json as valueJson from sync_cache where cache_key like 'cloud-bridge:cursor:%'",
				)
				.get() as { valueJson: string };
		const hydrationRow = () =>
			home.db
				.prepare(
					"select value_json as valueJson from sync_cache where cache_key like 'cloud-bridge:bookmark-hydration:%'",
				)
				.get() as { valueJson: string } | undefined;
		expect(JSON.parse(cursorRow().valueJson)).toMatchObject({
			cloudBookmarkUpdatedAt: timestampTwo,
			localBookmarkUpdatedAt: localTimestamp,
			nativeBookmarkUpdatedAt: localTimestamp,
		});
		expect(hydrationRow()).toBeUndefined();
		home.db
			.prepare(
				"delete from tweet_collections where account_id = 'account:test' and tweet_id = 'tweet:seed'",
			)
			.run();
		home.db
			.prepare(
				"delete from local_tweet_bookmarks where account_id = 'account:test' and tweet_id = 'tweet:seed'",
			)
			.run();
		home.db.prepare("delete from tweets where id = 'tweet:seed'").run();
		home.db.prepare("delete from profiles where id = 'profile:seed'").run();

		let removeCapabilityAtSecondPage = true;
		let completedCloudRollback = false;
		let thirdBookmarkAvailable = false;
		const replayCursors: string[] = [];
		const upgradedFetch = vi.fn(async (_url, init) => {
			const request = JSON.parse(String(init?.body)) as {
				purpose: string;
				cursor: { cloudBookmarkUpdatedAt: string };
			};
			if (request.purpose !== "bookmarks") return Response.json({ ok: true });
			const cursor = request.cursor.cloudBookmarkUpdatedAt;
			replayCursors.push(cursor);
			if (cursor === "") {
				return Response.json(
					cloudPage({
						rows: [bookmark(tweetOne.id, timestampOne)],
						profiles: [profileOne],
						tweets: [tweetOne],
						updatedAt: timestampOne,
						caughtUp: false,
					}),
				);
			}
			if (cursor === timestampOne) {
				const response = cloudPage({
					rows: [bookmark(tweetTwo.id, timestampTwo)],
					profiles: [profileTwo],
					tweets: [tweetTwo],
					updatedAt: timestampTwo,
					caughtUp: false,
					capability: !removeCapabilityAtSecondPage,
				});
				removeCapabilityAtSecondPage = false;
				return Response.json(response);
			}
			if (cursor === timestampTwo && thirdBookmarkAvailable) {
				return Response.json(
					cloudPage({
						rows: [bookmark(tweetThree.id, timestampThree)],
						profiles: [profileThree],
						tweets: [tweetThree],
						updatedAt: timestampThree,
						caughtUp: false,
						capability: !completedCloudRollback,
					}),
				);
			}
			return Response.json(
				cloudPage({
					rows: [],
					profiles: [],
					tweets: [],
					updatedAt: cursor || timestampTwo,
					caughtUp: true,
				}),
			);
		});
		const firstUpgradedClient = new LocalCloudBridgeClient({
			url: "http://127.0.0.1:3000",
			token: "bridge-secret",
			accountId: "account:test",
			batchSize: 1,
			fetchImpl: upgradedFetch,
		});

		await firstUpgradedClient.runOnce();
		expect(replayCursors).toEqual([timestampTwo, "", timestampOne]);
		expect(firstUpgradedClient.getStatus().lastError).toContain(
			"hydration capability disappeared",
		);
		expect(JSON.parse(cursorRow().valueJson)).toMatchObject({
			cloudBookmarkUpdatedAt: timestampOne,
			localBookmarkUpdatedAt: localTimestamp,
			nativeBookmarkUpdatedAt: localTimestamp,
		});
		expect(JSON.parse(hydrationRow()?.valueJson ?? "{}")).toMatchObject({
			version: 1,
			accountId: "account:test",
			status: "replaying",
			completedAt: null,
		});
		expect(
			home.db
				.prepare(
					"select tweet_id as tweetId from local_tweet_bookmarks order by tweet_id",
				)
				.all(),
		).toEqual([{ tweetId: "tweet:one" }]);

		const restartedClient = new LocalCloudBridgeClient({
			url: "http://127.0.0.1:3000",
			token: "bridge-secret",
			accountId: "account:test",
			batchSize: 1,
			fetchImpl: upgradedFetch,
		});
		await restartedClient.runOnce();
		expect(replayCursors.slice(3)).toEqual([
			timestampOne,
			timestampTwo,
			timestampTwo,
		]);
		expect(JSON.parse(cursorRow().valueJson)).toMatchObject({
			cloudBookmarkUpdatedAt: timestampTwo,
		});
		expect(JSON.parse(hydrationRow()?.valueJson ?? "{}")).toMatchObject({
			version: 1,
			accountId: "account:test",
			status: "completed",
			completedAt: expect.any(String),
		});
		expect(
			listTimelineItems({
				resource: "home",
				bookmarkedOnly: true,
				limit: 10,
			})
				.map((item) => item.id)
				.sort(),
		).toEqual(["tweet:one", "tweet:two"]);

		const countsBefore = home.db
			.prepare(
				`select
					(select count(*) from profiles) as profiles,
					(select count(*) from tweets) as tweets,
					(select count(*) from local_tweet_bookmarks) as bookmarks`,
			)
			.get();
		const requestCountBefore = replayCursors.length;
		await restartedClient.runOnce();
		expect(replayCursors.slice(requestCountBefore)).toEqual([timestampTwo]);
		expect(
			home.db
				.prepare(
					`select
						(select count(*) from profiles) as profiles,
						(select count(*) from tweets) as tweets,
						(select count(*) from local_tweet_bookmarks) as bookmarks`,
				)
				.get(),
		).toEqual(countsBefore);

		thirdBookmarkAvailable = true;
		completedCloudRollback = true;
		const rollbackRequestCount = replayCursors.length;
		await restartedClient.runOnce();
		expect(replayCursors.slice(rollbackRequestCount)).toEqual([timestampTwo]);
		expect(restartedClient.getStatus().lastError).toContain(
			"hydration capability disappeared",
		);
		expect(JSON.parse(cursorRow().valueJson)).toMatchObject({
			cloudBookmarkUpdatedAt: timestampTwo,
		});
		expect(JSON.parse(hydrationRow()?.valueJson ?? "{}")).toMatchObject({
			status: "completed",
			completedAt: expect.any(String),
		});
		expect(
			home.db
				.prepare("select count(*) as count from local_tweet_bookmarks")
				.get(),
		).toEqual({ count: 2 });

		completedCloudRollback = false;
		await restartedClient.runOnce();
		expect(JSON.parse(cursorRow().valueJson)).toMatchObject({
			cloudBookmarkUpdatedAt: timestampThree,
		});
		expect(
			listTimelineItems({
				resource: "home",
				bookmarkedOnly: true,
				limit: 10,
			})
				.map((item) => item.id)
				.sort(),
		).toEqual(["tweet:one", "tweet:three", "tweet:two"]);
	});

	it("renders all 99 native X bookmarks after a 90 plus 9 cloud bridge walk", async () => {
		const home = getHome();
		insertTestAccount(home.db);
		insertTestProfile(home.db);
		const insertCollection = home.db.prepare(
			`insert into tweet_collections (
				account_id, tweet_id, kind, collected_at, source, raw_json, updated_at
			) values ('account:test', ?, 'bookmarks', ?, 'xurl', '{}', ?)`,
		);
		for (let index = 0; index < 99; index += 1) {
			const tweetId = `bookmark:${String(index).padStart(3, "0")}`;
			insertTestTweet(home.db, {
				id: tweetId,
				text: `X bookmark ${String(index)}`,
			});
			insertCollection.run(
				tweetId,
				"2026-08-03T08:00:00.000Z",
				"2026-08-03T08:00:00.000Z",
			);
		}
		const first = buildLocalCloudBridgeBatch({
			purpose: "bookmarks",
			accountId: "account:test",
			limit: 90,
			db: home.db,
		});
		const second = buildLocalCloudBridgeBatch({
			purpose: "bookmarks",
			accountId: "account:test",
			limit: 90,
			cursor: first.cursor,
			db: home.db,
		});
		expect(first.nativeBookmarks).toHaveLength(90);
		expect(first.caughtUp).toBe(false);
		expect(second.nativeBookmarks).toHaveLength(9);
		expect(second.caughtUp).toBe(true);

		home.switchHome();
		await importLocalCloudBridgeBatch(first);
		await importLocalCloudBridgeBatch(second);
		expect(
			listTimelineItems({
				resource: "home",
				bookmarkedOnly: true,
				limit: 120,
			}),
		).toHaveLength(99);
	});

	it("paginates bookmark rows with identical timestamps without dropping any", () => {
		const home = getHome();
		insertTestAccount(home.db);
		insertTestProfile(home.db);
		for (const tweetId of ["tweet:one", "tweet:two", "tweet:three"]) {
			insertTestTweet(home.db, { id: tweetId });
			home.db
				.prepare(
					`insert into local_tweet_bookmarks (
						account_id, tweet_id, is_bookmarked, created_at, updated_at
					) values ('account:test', ?, 1, ?, ?)`,
				)
				.run(tweetId, "2026-08-03T08:00:00.000Z", "2026-08-03T08:00:00.000Z");
		}

		const first = buildLocalCloudBridgeBatch({
			purpose: "bookmarks",
			accountId: "account:test",
			limit: 2,
			db: home.db,
		});
		const second = buildLocalCloudBridgeBatch({
			purpose: "bookmarks",
			accountId: "account:test",
			limit: 2,
			cursor: first.cursor,
			db: home.db,
		});

		expect(first.caughtUp).toBe(false);
		expect(second.caughtUp).toBe(true);
		expect(
			[...first.localBookmarks, ...second.localBookmarks].map(
				(row) => row.tweetId,
			),
		).toEqual(["tweet:one", "tweet:three", "tweet:two"]);
	});

	it("preserves bookmark cursors when a later live page advances its edge cursor", () => {
		const home = getHome();
		insertTestAccount(home.db);
		insertTestProfile(home.db);
		insertTestTweet(home.db);
		home.db
			.prepare(
				`insert into local_tweet_bookmarks (
					account_id, tweet_id, is_bookmarked, created_at, updated_at
				) values ('account:test', 'tweet:test', 1, ?, ?)`,
			)
			.run("2026-08-03T08:00:00.000Z", "2026-08-03T08:00:00.000Z");
		home.db
			.prepare(
				`insert into tweet_account_edges (
					account_id, tweet_id, kind, first_seen_at, last_seen_at,
					seen_count, source, raw_json, updated_at
				) values ('account:test', 'tweet:test', 'home', ?, ?, 1, 'bird', '{}', ?)`,
			)
			.run(
				"2026-08-03T09:00:00.000Z",
				"2026-08-03T09:00:00.000Z",
				"2026-08-03T09:00:00.000Z",
			);

		const bookmarkBatch = buildLocalCloudBridgeBatch({
			purpose: "bookmarks",
			accountId: "account:test",
			limit: 2,
			db: home.db,
		});
		const liveBatch = buildLocalCloudBridgeBatch({
			purpose: "live",
			accountId: "account:test",
			limit: 2,
			cursor: bookmarkBatch.cursor,
			db: home.db,
		});

		expect(liveBatch.cursor).toMatchObject({
			localBookmarkUpdatedAt: bookmarkBatch.cursor.localBookmarkUpdatedAt,
			localBookmarkAccountId: bookmarkBatch.cursor.localBookmarkAccountId,
			localBookmarkTweetId: bookmarkBatch.cursor.localBookmarkTweetId,
		});
	});

	it("restarts bookmark cursors when the source account changes", () => {
		const home = getHome();
		insertTestAccount(home.db, { id: "account:a", handle: "@a" });
		insertTestAccount(home.db, {
			id: "account:b",
			handle: "@b",
			externalUserId: "2000",
			isDefault: 0,
		});
		insertTestProfile(home.db);
		insertTestTweet(home.db);
		const insertBookmark = home.db.prepare(
			`insert into local_tweet_bookmarks (
				account_id, tweet_id, is_bookmarked, created_at, updated_at
			) values (?, 'tweet:test', 1, ?, ?)`,
		);
		insertBookmark.run(
			"account:a",
			"2026-08-03T10:00:00.000Z",
			"2026-08-03T10:00:00.000Z",
		);
		insertBookmark.run(
			"account:b",
			"2026-08-03T08:00:00.000Z",
			"2026-08-03T08:00:00.000Z",
		);

		const accountA = buildLocalCloudBridgeBatch({
			purpose: "bookmarks",
			accountId: "account:a",
			db: home.db,
		});
		const accountB = buildLocalCloudBridgeBatch({
			purpose: "bookmarks",
			accountId: "account:b",
			cursor: accountA.cursor,
			db: home.db,
		});

		expect(accountA.cursor.bookmarkSourceAccountId).toBe("account:a");
		expect(accountB.cursor.bookmarkSourceAccountId).toBe("account:b");
		expect(accountB.localBookmarks).toEqual([
			expect.objectContaining({
				accountId: "account:b",
				tweetId: "tweet:test",
				updatedAt: "2026-08-03T08:00:00.000Z",
			}),
		]);
	});

	it("rejects malformed, duplicate, and cross-account bookmark rows", async () => {
		const home = getHome();
		insertTestAccount(home.db);
		insertTestProfile(home.db);
		insertTestTweet(home.db);
		const batch = buildLocalCloudBridgeBatch({
			purpose: "bookmarks",
			accountId: "account:test",
			db: home.db,
		});
		const validRow = {
			accountId: "account:test",
			tweetId: "tweet:test",
			isBookmarked: 1,
			createdAt: "2026-08-03T08:00:00.000Z",
			updatedAt: "2026-08-03T08:00:00.000Z",
		};

		await expect(
			importLocalCloudBridgeBatch({
				...batch,
				localBookmarks: [validRow, validRow],
			}),
		).rejects.toThrow("Duplicate saved row identity");
		await expect(
			importLocalCloudBridgeBatch({
				...batch,
				localBookmarks: [
					{ ...validRow, accountId: "account:other", updatedAt: "bad" },
				],
			}),
		).rejects.toThrow("Invalid ISO datetime");
	});

	it("rejects a saved account whose stable X user id conflicts with cloud", async () => {
		const home = getHome();
		insertTestAccount(home.db, { externalUserId: "1000" });
		const batch = buildLocalCloudBridgeBatch({
			purpose: "bookmarks",
			accountId: "account:test",
			db: home.db,
		});

		home.switchHome();
		process.env.BIRDCLAW_6551_FAILOVER_MODE = "1";
		process.env.BIRDCLAW_6551_ACCOUNT_ID = "acct_primary";
		insertTestAccount(home.db, {
			id: "acct_primary",
			externalUserId: "2000",
			transport: "twitter6551",
		});

		await expect(importLocalCloudBridgeBatch(batch)).rejects.toThrow(
			"does not match the canonical X user",
		);
	});

	it("rejects a live batch with a conflicting stable X user id before writes", async () => {
		const home = getHome();
		insertTestAccount(home.db, { externalUserId: "1000" });
		insertTestProfile(home.db);
		insertTestTweet(home.db);
		home.db
			.prepare(
				`insert into tweet_account_edges (
					account_id, tweet_id, kind, first_seen_at, last_seen_at,
					seen_count, source, raw_json, updated_at
				) values ('account:test', 'tweet:test', 'home', ?, ?, 1, 'bird', '{}', ?)`,
			)
			.run(
				"2026-08-03T08:00:00.000Z",
				"2026-08-03T08:00:00.000Z",
				"2026-08-03T08:00:00.000Z",
			);
		const batch = buildLocalCloudBridgeBatch({
			purpose: "live",
			accountId: "account:test",
			lookbackHours: 24,
			now: new Date("2026-08-03T09:00:00.000Z"),
			db: home.db,
		});

		home.switchHome();
		process.env.BIRDCLAW_6551_FAILOVER_MODE = "1";
		process.env.BIRDCLAW_6551_ACCOUNT_ID = "acct_primary";
		insertTestAccount(home.db, {
			id: "acct_primary",
			externalUserId: "2000",
			transport: "twitter6551",
		});

		await expect(importLocalCloudBridgeBatch(batch)).rejects.toThrow(
			"does not match the canonical X user",
		);
		expect(
			home.db
				.prepare(
					"select external_user_id as externalUserId from accounts where id = ?",
				)
				.get("acct_primary"),
		).toEqual({ externalUserId: "2000" });
		expect(
			home.db.prepare("select count(*) as count from tweets").get(),
		).toEqual({
			count: 0,
		});
		expect(
			home.db
				.prepare("select count(*) as count from tweet_account_edges")
				.get(),
		).toEqual({ count: 0 });
	});

	it("lets cloud bookmark tombstones win equal-time conflicts", async () => {
		const home = getHome();
		insertTestAccount(home.db);
		insertTestProfile(home.db);
		insertTestTweet(home.db);
		home.db
			.prepare(
				`insert into local_tweet_bookmarks (
					account_id, tweet_id, is_bookmarked, created_at, updated_at
				) values (?, ?, 1, ?, ?)`,
			)
			.run(
				"account:test",
				"tweet:test",
				"2026-08-03T08:00:00.000Z",
				"2026-08-03T09:00:00.000Z",
			);
		const client = new LocalCloudBridgeClient({
			url: "http://127.0.0.1:3000",
			token: "bridge-secret",
			accountId: "account:test",
			fetchImpl: vi.fn(async (_url, init) => {
				const batch = JSON.parse(String(init?.body)) as {
					purpose: "live" | "history" | "bookmarks";
					caughtUp: boolean;
				};
				return Response.json({
					ok: true,
					bookmarkSyncVersion: 1,
					localBookmarks:
						batch.purpose !== "history" && batch.caughtUp
							? [
									{
										accountId: "account:test",
										tweetId: "tweet:test",
										isBookmarked: 0,
										createdAt: "2026-08-03T08:00:00.000Z",
										updatedAt: "2026-08-03T09:00:00.000Z",
									},
								]
							: [],
					localBookmarkCursor: {
						updatedAt: "2026-08-03T09:00:00.000Z",
						accountId: "account:test",
						tweetId: "tweet:test",
					},
					localBookmarksCaughtUp: true,
				});
			}),
		});

		await client.runOnce();
		expect(
			home.db
				.prepare(
					"select is_bookmarked, updated_at from local_tweet_bookmarks where account_id = ? and tweet_id = ?",
				)
				.get("account:test", "tweet:test"),
		).toEqual({
			is_bookmarked: 0,
			updated_at: "2026-08-03T09:00:00.000Z",
		});
	});

	it("uploads live data without a heartbeat when local collection is not healthy", async () => {
		const home = getHome();
		insertTestAccount(home.db);
		insertTestProfile(home.db);
		insertTestTweet(home.db);
		home.db
			.prepare(
				`insert into tweet_account_edges (
				 account_id, tweet_id, kind, first_seen_at, last_seen_at,
				 seen_count, source, raw_json, updated_at
				) values (?, ?, 'home', ?, ?, 1, 'bird', '{}', ?)`,
			)
			.run(
				"account:test",
				"tweet:test",
				"2026-08-03T08:00:00.000Z",
				"2026-08-03T08:00:00.000Z",
				"2026-08-03T08:00:00.000Z",
			);
		const sentBatches: Array<{
			purpose: "live" | "history" | "bookmarks";
			homeTimelineSyncedAt: string | null;
			edges: unknown[];
		}> = [];
		const fetchImpl = vi.fn(
			async (_url: string | URL | Request, init?: RequestInit) => {
				sentBatches.push(JSON.parse(String(init?.body)));
				return Response.json({ ok: true });
			},
		);
		const client = new LocalCloudBridgeClient({
			url: "http://127.0.0.1:3000",
			token: "bridge-secret",
			fetchImpl,
			isReady: () => false,
			getHomeTimelineSyncedAt: () => "2026-08-03T08:00:00.000Z",
			now: () => new Date("2026-08-03T09:00:00.000Z"),
		});

		await client.runOnce();

		expect(sentBatches.map((batch) => batch.purpose)).toContain("bookmarks");
		expect(
			sentBatches.every((batch) => batch.homeTimelineSyncedAt === null),
		).toBe(true);
		const liveBatch = sentBatches.find((batch) => batch.purpose === "live");
		expect(liveBatch).toMatchObject({
			homeTimelineSyncedAt: null,
		});
		expect(liveBatch?.edges).toHaveLength(1);
		expect(client.getStatus().lastError).toContain("not fresh");
	});

	it("does not advance bookmark cursors when the cloud lacks the capability", async () => {
		const home = getHome();
		insertTestAccount(home.db);
		insertTestProfile(home.db);
		insertTestTweet(home.db);
		home.db
			.prepare(
				`insert into local_tweet_bookmarks (
					account_id, tweet_id, is_bookmarked, created_at, updated_at
				) values ('account:test', 'tweet:test', 1, ?, ?)`,
			)
			.run("2026-08-03T08:00:00.000Z", "2026-08-03T08:00:00.000Z");
		const client = new LocalCloudBridgeClient({
			url: "http://127.0.0.1:3000",
			token: "bridge-secret",
			accountId: "account:test",
			fetchImpl: vi.fn(async () => Response.json({ ok: true })),
		});

		await client.runOnce();
		const cursorRow = home.db
			.prepare(
				"select value_json as valueJson from sync_cache where cache_key like 'cloud-bridge:cursor:%'",
			)
			.get() as { valueJson: string };
		expect(JSON.parse(cursorRow.valueJson)).toMatchObject({
			localBookmarkUpdatedAt: "",
			localBookmarkAccountId: "",
			localBookmarkTweetId: "",
		});
	});

	it("shrinks oversized bookmark pages below the bridge request limit", async () => {
		const home = getHome();
		insertTestAccount(home.db);
		insertTestProfile(home.db);
		const largeRawJson = JSON.stringify({ blob: "x".repeat(960_000) });
		const insertCollection = home.db.prepare(
			`insert into tweet_collections (
				account_id, tweet_id, kind, collected_at, source, raw_json, updated_at
			) values ('account:test', ?, 'bookmarks', ?, 'xurl', ?, ?)`,
		);
		for (let index = 0; index < 8; index += 1) {
			const tweetId = `large:${String(index)}`;
			insertTestTweet(home.db, { id: tweetId });
			insertCollection.run(
				tweetId,
				"2026-08-03T08:00:00.000Z",
				largeRawJson,
				"2026-08-03T08:00:00.000Z",
			);
		}
		const bookmarkRequests: Array<{
			bytes: number;
			nativeRows: number;
			savedPageSize: number;
		}> = [];
		const client = new LocalCloudBridgeClient({
			url: "http://127.0.0.1:3000",
			token: "bridge-secret",
			accountId: "account:test",
			batchSize: 100,
			fetchImpl: vi.fn(async (_url, init) => {
				const body = String(init?.body);
				const batch = JSON.parse(body) as {
					purpose: string;
					savedPageSize: number;
					nativeBookmarks: unknown[];
					cursor: {
						cloudBookmarkUpdatedAt: string;
						cloudBookmarkAccountId: string;
						cloudBookmarkTweetId: string;
					};
				};
				if (batch.purpose !== "bookmarks") return Response.json({ ok: true });
				bookmarkRequests.push({
					bytes: Buffer.byteLength(body),
					nativeRows: batch.nativeBookmarks.length,
					savedPageSize: batch.savedPageSize,
				});
				return Response.json({
					ok: true,
					bookmarkSyncVersion: 1,
					localBookmarks: [],
					localBookmarkCursor: {
						updatedAt: batch.cursor.cloudBookmarkUpdatedAt,
						accountId: batch.cursor.cloudBookmarkAccountId,
						tweetId: batch.cursor.cloudBookmarkTweetId,
					},
					localBookmarksCaughtUp: true,
				});
			}),
		});

		await client.runOnce();
		expect(
			bookmarkRequests.reduce((sum, page) => sum + page.nativeRows, 0),
		).toBe(8);
		expect(bookmarkRequests[0]?.savedPageSize).toBeLessThan(100);
		expect(
			bookmarkRequests.every((page) => page.bytes <= 7 * 1024 * 1024),
		).toBe(true);
		expect(client.getStatus().lastError).toBeNull();
	});

	it("continues live upload when an older cloud rejects bookmark purpose", async () => {
		const home = getHome();
		insertTestAccount(home.db);
		insertTestProfile(home.db);
		insertTestTweet(home.db);
		home.db
			.prepare(
				`insert into local_tweet_bookmarks (
					account_id, tweet_id, is_bookmarked, created_at, updated_at
				) values ('account:test', 'tweet:test', 1, ?, ?)`,
			)
			.run("2026-08-03T08:00:00.000Z", "2026-08-03T08:00:00.000Z");
		home.db
			.prepare(
				`insert into tweet_account_edges (
					account_id, tweet_id, kind, first_seen_at, last_seen_at,
					seen_count, source, raw_json, updated_at
				) values ('account:test', 'tweet:test', 'home', ?, ?, 1, 'bird', '{}', ?)`,
			)
			.run(
				"2026-08-03T09:00:00.000Z",
				"2026-08-03T09:00:00.000Z",
				"2026-08-03T09:00:00.000Z",
			);
		const purposes: string[] = [];
		const client = new LocalCloudBridgeClient({
			url: "http://127.0.0.1:3000",
			token: "bridge-secret",
			accountId: "account:test",
			lookbackHours: 24 * 365,
			now: () => new Date("2026-08-04T00:00:00.000Z"),
			fetchImpl: vi.fn(async (_url, init) => {
				const batch = JSON.parse(String(init?.body)) as { purpose: string };
				purposes.push(batch.purpose);
				return batch.purpose === "bookmarks"
					? Response.json(
							{ ok: false, message: "Invalid enum value for purpose" },
							{ status: 400 },
						)
					: Response.json({ ok: true });
			}),
		});

		await client.runOnce();
		expect(purposes).toContain("bookmarks");
		expect(purposes).toContain("live");
		expect(client.getStatus()).toMatchObject({
			uploadedEdges: 1,
			lastError: expect.stringContaining("Bookmark sync is pending"),
		});
		const cursorRow = home.db
			.prepare(
				"select value_json as valueJson from sync_cache where cache_key like 'cloud-bridge:cursor:%'",
			)
			.get() as { valueJson: string };
		expect(JSON.parse(cursorRow.valueJson)).toMatchObject({
			localBookmarkUpdatedAt: "",
			localBookmarkAccountId: "",
			localBookmarkTweetId: "",
		});
	});

	it("rejects cloud bookmark rows for another source account", async () => {
		const home = getHome();
		insertTestAccount(home.db);
		const client = new LocalCloudBridgeClient({
			url: "http://127.0.0.1:3000",
			token: "bridge-secret",
			accountId: "account:test",
			fetchImpl: vi.fn(async () =>
				Response.json({
					ok: true,
					bookmarkSyncVersion: 1,
					localBookmarks: [
						{
							accountId: "account:other",
							tweetId: "tweet:test",
							isBookmarked: 1,
							createdAt: "2026-08-03T08:00:00.000Z",
							updatedAt: "2026-08-03T08:00:00.000Z",
						},
					],
					localBookmarkCursor: {
						updatedAt: "2026-08-03T08:00:00.000Z",
						accountId: "acct_primary",
						tweetId: "tweet:test",
					},
					localBookmarksCaughtUp: true,
				}),
			),
		});

		const status = await client.runOnce();
		expect(status.lastError).toContain("another account");
		expect(
			home.db
				.prepare("select count(*) as count from local_tweet_bookmarks")
				.get(),
		).toEqual({ count: 0 });
	});

	it("uses one canonical account and merges profiles by handle", async () => {
		const home = getHome();
		insertTestAccount(home.db);
		insertTestProfile(home.db);
		insertTestTweet(home.db);
		home.db
			.prepare(
				`
				insert into tweet_account_edges (
					account_id, tweet_id, kind, first_seen_at, last_seen_at,
					seen_count, source, raw_json, updated_at
				) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
				`,
			)
			.run(
				"account:test",
				"tweet:test",
				"home",
				"2026-07-31T08:00:00.000Z",
				"2026-07-31T08:00:00.000Z",
				1,
				"bird",
				"{}",
				"2026-07-31T08:00:00.000Z",
			);
		const batch = buildLocalCloudBridgeBatch({
			cursor: {
				updatedAt: "2026-07-31T07:59:00.000Z",
				accountId: "",
				tweetId: "",
				kind: "",
			},
			db: home.db,
		});

		home.switchHome();
		process.env.BIRDCLAW_6551_FAILOVER_MODE = "1";
		process.env.BIRDCLAW_6551_ACCOUNT_ID = "acct_primary";
		insertTestAccount(home.db, {
			id: "acct_6551",
			name: "Legacy 6551",
			handle: "@6551_watch",
			transport: "twitter6551",
			isDefault: 1,
		});
		insertTestProfile(home.db, {
			id: "profile:canonical",
			handle: "TEST",
		});
		home.db
			.prepare(
				`
				insert into tweet_account_edges (
					account_id, tweet_id, kind, first_seen_at, last_seen_at,
					seen_count, source, raw_json, updated_at
				) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
				`,
			)
			.run(
				"acct_6551",
				"tweet:test",
				"home",
				"2026-07-31T07:00:00.000Z",
				"2026-07-31T07:00:00.000Z",
				1,
				"twitter6551",
				"{}",
				"2026-07-31T07:00:00.000Z",
			);
		home.db
			.prepare(
				`
				insert into local_tweet_bookmarks (
					account_id, tweet_id, is_bookmarked, created_at, updated_at
				) values (?, ?, 1, ?, ?)
				`,
			)
			.run(
				"acct_6551",
				"tweet:test",
				"2026-07-31T07:10:00.000Z",
				"2026-07-31T07:10:00.000Z",
			);
		home.db
			.prepare(
				`
				insert into tweet_collections (
					account_id, tweet_id, kind, collected_at, source, raw_json,
					updated_at
				) values (?, ?, 'bookmarks', ?, 'twitter6551', '{}', ?)
				`,
			)
			.run(
				"acct_6551",
				"tweet:test",
				"2026-07-31T07:10:00.000Z",
				"2026-07-31T07:10:00.000Z",
			);

		await importLocalCloudBridgeBatch(batch);

		expect(
			home.db
				.prepare(
					"select account_id as accountId from tweet_account_edges where tweet_id = ?",
				)
				.all("tweet:test"),
		).toEqual([{ accountId: "acct_primary" }]);
		expect(
			home.db
				.prepare(
					"select author_profile_id as authorProfileId from tweets where id = ?",
				)
				.get("tweet:test"),
		).toEqual({ authorProfileId: "profile:canonical" });
		expect(
			home.db
				.prepare(
					"select count(*) as count from profiles where lower(handle) = 'test'",
				)
				.get(),
		).toEqual({ count: 1 });
		expect(
			home.db
				.prepare("select count(*) as count from accounts where id = ?")
				.get("acct_6551"),
		).toEqual({ count: 0 });
		expect(
			home.db
				.prepare(
					"select account_id as accountId, is_bookmarked as isBookmarked from local_tweet_bookmarks",
				)
				.all(),
		).toEqual([{ accountId: "acct_primary", isBookmarked: 1 }]);
		expect(
			home.db
				.prepare("select account_id as accountId, kind from tweet_collections")
				.all(),
		).toEqual([{ accountId: "acct_primary", kind: "bookmarks" }]);
	});

	it("uploads only the configured local collector account", () => {
		const home = getHome();
		insertTestAccount(home.db);
		insertTestAccount(home.db, {
			id: "account:other",
			handle: "@other",
			isDefault: 0,
		});
		insertTestProfile(home.db);
		insertTestTweet(home.db, { id: "tweet:one" });
		insertTestTweet(home.db, { id: "tweet:two" });
		const insertEdge = home.db.prepare(
			`
			insert into tweet_account_edges (
				account_id, tweet_id, kind, first_seen_at, last_seen_at,
				seen_count, source, raw_json, updated_at
			) values (?, ?, 'home', ?, ?, 1, 'bird', '{}', ?)
			`,
		);
		insertEdge.run(
			"account:test",
			"tweet:one",
			"2026-07-31T08:00:00.000Z",
			"2026-07-31T08:00:00.000Z",
			"2026-07-31T08:00:00.000Z",
		);
		insertEdge.run(
			"account:other",
			"tweet:two",
			"2026-07-31T08:01:00.000Z",
			"2026-07-31T08:01:00.000Z",
			"2026-07-31T08:01:00.000Z",
		);

		const batch = buildLocalCloudBridgeBatch({
			accountId: "account:test",
			cursor: {
				updatedAt: "2026-07-31T07:59:00.000Z",
				accountId: "",
				tweetId: "",
				kind: "",
			},
			db: home.db,
		});

		expect(batch.edges.map((edge) => edge.accountId)).toEqual(["account:test"]);
		expect(batch.tweets.map((tweet) => tweet.id)).toEqual(["tweet:one"]);
	});

	it("marks only the final backlog page as caught up", async () => {
		const home = getHome();
		insertTestAccount(home.db);
		insertTestProfile(home.db);
		insertTestTweet(home.db, { id: "tweet:one" });
		insertTestTweet(home.db, { id: "tweet:two" });
		const insertEdge = home.db.prepare(
			`
			insert into tweet_account_edges (
				account_id, tweet_id, kind, first_seen_at, last_seen_at,
				seen_count, source, raw_json, updated_at
			) values (?, ?, 'home', ?, ?, 1, 'bird', '{}', ?)
			`,
		);
		insertEdge.run(
			"account:test",
			"tweet:one",
			"2026-07-31T08:00:00.000Z",
			"2026-07-31T08:00:00.000Z",
			"2026-07-31T08:00:00.000Z",
		);
		insertEdge.run(
			"account:test",
			"tweet:two",
			"2026-07-31T08:01:00.000Z",
			"2026-07-31T08:01:00.000Z",
			"2026-07-31T08:01:00.000Z",
		);
		const sentBatches: Array<{
			purpose: "live" | "history" | "bookmarks";
			homeTimelineSyncedAt: string | null;
			caughtUp: boolean;
			edges: unknown[];
		}> = [];
		const homeTimelineSyncedAt = "2026-07-31T08:59:00.000Z";
		const client = new LocalCloudBridgeClient({
			url: "http://127.0.0.1:3000",
			token: "bridge-secret",
			batchSize: 1,
			now: () => new Date("2026-07-31T09:00:00.000Z"),
			isReady: () => true,
			getHomeTimelineSyncedAt: () => homeTimelineSyncedAt,
			fetchImpl: vi.fn(async (_url, init) => {
				sentBatches.push(JSON.parse(String(init?.body)));
				return Response.json({ ok: true });
			}),
		});

		await client.runOnce();

		expect(sentBatches).not.toHaveLength(0);
		expect(
			sentBatches.every(
				(batch) => batch.homeTimelineSyncedAt === homeTimelineSyncedAt,
			),
		).toBe(true);
		const liveBatches = sentBatches.filter((batch) => batch.purpose === "live");
		expect(liveBatches.map((batch) => batch.caughtUp)).toEqual([
			false,
			false,
			true,
		]);
		expect(liveBatches.map((batch) => batch.edges.length)).toEqual([1, 1, 0]);
		expect(client.getStatus()).toMatchObject({
			lastError: null,
			uploadedEdges: 2,
			backfillCompleted: true,
			backfilledEdges: 2,
		});
	});

	it("merges newer cloud priority tombstones back into the local database", async () => {
		const home = getHome();
		home.db
			.prepare(
				`insert into birdclaw_profile_priorities (
				 priority_key, identifier, additional_name, is_special_follow, updated_at
				) values (?, ?, ?, ?, ?)`,
			)
			.run("id:42", "42", "ada", 1, "2026-08-01T08:00:00.000Z");
		const client = new LocalCloudBridgeClient({
			url: "http://127.0.0.1:3000",
			token: "bridge-secret",
			now: () => new Date("2026-08-01T10:00:00.000Z"),
			fetchImpl: vi.fn(async (_url, init) => {
				const batch = JSON.parse(String(init?.body)) as {
					purpose: "live" | "history";
					caughtUp: boolean;
				};
				return Response.json({
					ok: true,
					profilePriorities:
						batch.purpose === "live" && batch.caughtUp
							? [
									{
										priorityKey: "id:42",
										identifier: "42",
										additionalName: "ada",
										isSpecialFollow: 0,
										updatedAt: "2026-08-01T09:00:00.000Z",
									},
								]
							: [],
				});
			}),
		});

		await client.runOnce();
		expect(
			home.db
				.prepare(
					"select is_special_follow, updated_at from birdclaw_profile_priorities where priority_key = 'id:42'",
				)
				.get(),
		).toEqual({
			is_special_follow: 0,
			updated_at: "2026-08-01T09:00:00.000Z",
		});
	});

	it("does not transfer a synced priority when another account reuses the handle", async () => {
		const home = getHome();
		home.db
			.prepare(
				`insert into birdclaw_profile_priorities (
				 priority_key, identifier, additional_name, is_special_follow, updated_at
				) values (?, ?, ?, ?, ?)`,
			)
			.run("id:42", "42", "reused", 1, "2026-08-01T08:00:00.000Z");
		const client = new LocalCloudBridgeClient({
			url: "http://127.0.0.1:3000",
			token: "bridge-secret",
			fetchImpl: vi.fn(async (_url, init) => {
				const batch = JSON.parse(String(init?.body)) as {
					purpose: "live" | "history";
					caughtUp: boolean;
				};
				return Response.json({
					ok: true,
					profilePriorities:
						batch.purpose === "live" && batch.caughtUp
							? [
									{
										priorityKey: "id:41",
										identifier: "41",
										additionalName: "reused",
										isSpecialFollow: 0,
										updatedAt: "2026-08-01T09:00:00.000Z",
									},
								]
							: [],
				});
			}),
		});

		await client.runOnce();
		expect(
			home.db
				.prepare(
					"select priority_key, is_special_follow from birdclaw_profile_priorities order by priority_key",
				)
				.all(),
		).toEqual([
			{ priority_key: "id:41", is_special_follow: 0 },
			{ priority_key: "id:42", is_special_follow: 1 },
		]);
	});

	it("rejects malformed priority identities returned by the bridge", async () => {
		const client = new LocalCloudBridgeClient({
			url: "http://127.0.0.1:3000",
			token: "bridge-secret",
			fetchImpl: vi.fn(async () =>
				Response.json({
					ok: true,
					profilePriorities: [
						{
							priorityKey: "id:42",
							identifier: "41",
							additionalName: "ada",
							isSpecialFollow: 1,
							updatedAt: "not-a-date",
						},
					],
				}),
			),
		});

		const status = await client.runOnce();
		expect(status.lastError).toContain("cloud bridge failed (200)");
	});

	it("resumes a one-time history backfill without rewinding the live cursor", async () => {
		const home = getHome();
		insertTestAccount(home.db);
		insertTestProfile(home.db);
		const insertEdge = home.db.prepare(
			`
			insert into tweet_account_edges (
				account_id, tweet_id, kind, first_seen_at, last_seen_at,
				seen_count, source, raw_json, updated_at
			) values ('account:test', ?, 'home', ?, ?, 1, 'bird', '{}', ?)
			`,
		);
		for (const [index, tweetId] of [
			"tweet:one",
			"tweet:two",
			"tweet:three",
		].entries()) {
			const timestamp = `2020-01-01T00:0${String(index)}:00.000Z`;
			insertTestTweet(home.db, { id: tweetId, createdAt: timestamp });
			insertEdge.run(tweetId, timestamp, timestamp, timestamp);
		}

		let historyRequests = 0;
		const firstClient = new LocalCloudBridgeClient({
			url: "http://127.0.0.1:3000",
			token: "bridge-secret",
			batchSize: 1,
			now: () => new Date("2026-08-02T00:00:00.000Z"),
			fetchImpl: vi.fn(async (_url, init) => {
				const batch = JSON.parse(String(init?.body)) as {
					purpose: "live" | "history";
				};
				if (batch.purpose === "history") {
					historyRequests += 1;
					if (historyRequests === 2) {
						return Response.json(
							{ ok: false, message: "pause history backfill" },
							{ status: 503 },
						);
					}
				}
				return Response.json({ ok: true });
			}),
		});

		await firstClient.runOnce();

		expect(firstClient.getStatus()).toMatchObject({
			lastError: null,
			backfillCompleted: false,
			backfillLastError: "pause history backfill",
			backfilledEdges: 1,
		});
		const liveRow = home.db
			.prepare(
				"select value_json as valueJson from sync_cache where cache_key like 'cloud-bridge:cursor:%'",
			)
			.get() as { valueJson: string };
		const historyRow = home.db
			.prepare(
				"select value_json as valueJson from sync_cache where cache_key like 'cloud-bridge:history:%'",
			)
			.get() as { valueJson: string };
		expect(JSON.parse(liveRow.valueJson)).toMatchObject({
			updatedAt: "2026-08-01T00:00:00.000Z",
		});
		expect(JSON.parse(historyRow.valueJson)).toMatchObject({
			completedAt: null,
			cursor: { tweetId: "tweet:one" },
		});

		const resumedHistoryTweetIds: string[][] = [];
		const resumedClient = new LocalCloudBridgeClient({
			url: "http://127.0.0.1:3000",
			token: "bridge-secret",
			batchSize: 1,
			now: () => new Date("2026-08-02T00:01:00.000Z"),
			fetchImpl: vi.fn(async (_url, init) => {
				const batch = JSON.parse(String(init?.body)) as {
					purpose: "live" | "history";
					edges: Array<{ tweetId: string }>;
				};
				if (batch.purpose === "history") {
					resumedHistoryTweetIds.push(batch.edges.map((edge) => edge.tweetId));
				}
				return Response.json({ ok: true });
			}),
		});

		await resumedClient.runOnce();
		expect(resumedHistoryTweetIds).toEqual([
			["tweet:two"],
			["tweet:three"],
			[],
		]);
		expect(resumedClient.getStatus()).toMatchObject({
			lastError: null,
			backfillCompleted: true,
			backfillLastError: null,
			backfilledEdges: 2,
		});
		const completedState = home.db
			.prepare(
				"select value_json as valueJson from sync_cache where cache_key like 'cloud-bridge:history:%'",
			)
			.get() as { valueJson: string };
		expect(JSON.parse(completedState.valueJson)).toMatchObject({
			completedAt: "2026-08-02T00:01:00.000Z",
			cursor: { tweetId: "tweet:three" },
		});

		const completedRequestCount = resumedHistoryTweetIds.length;
		await resumedClient.runOnce();
		expect(resumedHistoryTweetIds).toHaveLength(completedRequestCount);
		const finalLiveRow = home.db
			.prepare(
				"select value_json as valueJson from sync_cache where cache_key like 'cloud-bridge:cursor:%'",
			)
			.get() as { valueJson: string };
		expect(JSON.parse(finalLiveRow.valueJson)).toMatchObject({
			updatedAt: "2026-08-01T00:00:00.000Z",
		});
	});

	it("authenticates the bridge with a dedicated constant-time token", () => {
		process.env.BIRDCLAW_LOCAL_BRIDGE_TOKEN = "bridge-secret";
		expect(verifyLocalCloudBridgeToken("bridge-secret")).toBe(true);
		expect(verifyLocalCloudBridgeToken("wrong-secret")).toBe(false);
	});
});
