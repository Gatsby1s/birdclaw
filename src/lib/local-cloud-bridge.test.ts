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
		await importLocalCloudBridgeBatch(batch);
		await importLocalCloudBridgeBatch(batch);

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

	it("does not send a heartbeat until local collection is healthy", async () => {
		const fetchImpl = vi.fn();
		const client = new LocalCloudBridgeClient({
			url: "http://127.0.0.1:3000",
			token: "bridge-secret",
			fetchImpl,
			isReady: () => false,
		});

		await client.runOnce();

		expect(fetchImpl).not.toHaveBeenCalled();
		expect(client.getStatus().lastError).toContain("not fresh");
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
			purpose: "live" | "history";
			caughtUp: boolean;
			edges: unknown[];
		}> = [];
		const client = new LocalCloudBridgeClient({
			url: "http://127.0.0.1:3000",
			token: "bridge-secret",
			batchSize: 1,
			now: () => new Date("2026-07-31T09:00:00.000Z"),
			fetchImpl: vi.fn(async (_url, init) => {
				sentBatches.push(JSON.parse(String(init?.body)));
				return Response.json({ ok: true });
			}),
		});

		await client.runOnce();

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
