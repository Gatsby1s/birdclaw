// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { useTestHome } from "../test/test-home";
import {
	ensureTwitter6551Account,
	ingestTwitter6551Tweets,
	normalizeTwitter6551Tweet,
	normalizeTwitter6551User,
	Twitter6551Client,
	Twitter6551Error,
	getTwitter6551RuntimeStatus,
	getTwitter6551RuntimeConfig,
	recordTwitter6551LocalHeartbeat,
	runTwitter6551Backfill,
	startTwitter6551WorkerManager,
	stopTwitter6551WorkerManager,
	Twitter6551Worker,
	twitter6551TweetsToPayload,
	twitter6551UserToXurl,
} from "./twitter-6551";

describe("6551 Twitter adapter", () => {
	const getHome = useTestHome({ prefix: "birdclaw-6551-" });

	it("normalizes REST users and tweets into the existing XURL contract", () => {
		const user = normalizeTwitter6551User({
			userId: "42",
			screenName: "Example",
			name: "Example User",
			followersCount: 123,
			profileImageUrl: "https://pbs.twimg.com/profile_images/example.jpg",
		});
		const tweet = normalizeTwitter6551Tweet({
			id: "100",
			text: "hello https://t.co/a",
			createdAt: "2026-07-30T10:00:00Z",
			userIdStr: "42",
			userScreenName: "Example",
			userName: "Example User",
			userFollowers: 123,
			conversationId: "90",
			replyId: "90",
			favoriteCount: 7,
			media: [
				{
					type: "photo",
					url: "https://pbs.twimg.com/media/example.jpg",
				},
			],
			urls: [
				{
					url: "https://t.co/a",
					expandedUrl: "https://example.com/article",
				},
			],
			mentions: [{ username: "other" }],
			hashtags: ["birdclaw"],
		});

		expect(user).toMatchObject({
			userId: "42",
			screenName: "Example",
			followersCount: 123,
		});
		expect(tweet).not.toBeNull();
		const payload = twitter6551TweetsToPayload([tweet!]);
		expect(payload.data[0]).toMatchObject({
			id: "100",
			author_id: "42",
			conversation_id: "90",
			referenced_tweets: [{ type: "replied_to", id: "90" }],
			public_metrics: { like_count: 7 },
		});
		expect(payload.includes?.users?.[0]).toMatchObject({
			id: "42",
			username: "Example",
		});
		expect(payload.includes?.media?.[0]).toMatchObject({
			type: "photo",
			url: "https://pbs.twimg.com/media/example.jpg",
		});
	});

	it("rejects tweet payloads without a stable external user id", () => {
		expect(
			normalizeTwitter6551Tweet({
				id: "100",
				text: "missing identity",
				userScreenName: "Example",
			}),
		).toBeNull();
	});

	it("normalizes legacy aliases, malformed collections, and every optional payload field", () => {
		expect(normalizeTwitter6551User(null)).toBeNull();
		expect(normalizeTwitter6551User([])).toBeNull();
		expect(normalizeTwitter6551User({ id: "1" })).toBeNull();
		expect(
			normalizeTwitter6551User({ id: 2, screenName: "nameless" }),
		).toMatchObject({
			userId: "2",
			name: "nameless",
		});
		const user = normalizeTwitter6551User({
			userIdStr: 42,
			userScreenName: "@legacy",
			twUserName: "Legacy User",
			description: "bio",
			userFollowers: "123",
			friendsCount: "45",
			userVerified: true,
			profileImageUrl: "https://pbs.twimg.com/avatar.jpg",
			profileBannerUrl: "https://pbs.twimg.com/banner.jpg",
		});
		expect(user).toMatchObject({
			userId: "42",
			screenName: "legacy",
			name: "Legacy User",
			followersCount: 123,
			friendsCount: 45,
			verified: true,
		});
		expect(twitter6551UserToXurl(user!)).toMatchObject({
			id: "42",
			description: "bio",
			verified: true,
			public_metrics: { followers_count: 123, following_count: 45 },
		});
		expect(
			twitter6551UserToXurl({
				userId: "1",
				screenName: "minimal",
				name: "minimal",
			}),
		).toEqual({
			id: "1",
			username: "minimal",
			name: "minimal",
			public_metrics: {},
		});

		const tweet = normalizeTwitter6551Tweet(
			JSON.stringify({
				twId: 500,
				content: "legacy tweet",
				created_at: "not-a-date",
				twAccount: "@legacy",
				twUserName: "Legacy User",
				userFollowers: "321",
				userVerified: false,
				conversationId: 400,
				inReplyToStatusId: 399,
				quotedStatus: { id: 398 },
				favoriteCount: "7",
				retweetCount: 6,
				replyCount: 5,
				quoteCount: 4,
				viewCount: 3,
				media: [
					null,
					{
						type: "image",
						url: "https://pbs.twimg.com/a.jpg",
						thumbnailUrl: "https://pbs.twimg.com/a-thumb.jpg",
					},
					{ type: "gif", url: "https://video.twimg.com/a.gif" },
					{ type: null, url: "https://pbs.twimg.com/unknown" },
					{ type: "video" },
				],
				urls: [
					null,
					{
						url: "https://t.co/a",
						expanded_url: "https://example.com/a",
						display_url: "example.com/a",
					},
					{ url: "https://t.co/b" },
					{ expandedUrl: "https://example.com/missing" },
				],
				mentions: [
					null,
					{ screenName: "@other", name: "Other" },
					{ username: "plain" },
					{ name: "missing username" },
				],
				hashtags: ["one", 2, null, ""],
			}),
			{ userId: "42", screenName: "fallback", name: "Fallback" },
		);
		expect(tweet).toMatchObject({
			id: "500",
			userId: "42",
			userScreenName: "legacy",
			replyId: "399",
			quotedTweetId: "398",
			favoriteCount: 7,
			media: [
				expect.objectContaining({
					type: "image",
					thumbUrl: "https://pbs.twimg.com/a-thumb.jpg",
				}),
				expect.objectContaining({ type: "gif" }),
				expect.objectContaining({ type: "unknown" }),
			],
			urls: [
				expect.objectContaining({
					expandedUrl: "https://example.com/a",
					displayUrl: "example.com/a",
				}),
				{ url: "https://t.co/b" },
			],
			mentions: [{ username: "other", name: "Other" }, { username: "plain" }],
			hashtags: ["one", "2"],
		});
		const payload = twitter6551TweetsToPayload([
			tweet!,
			{ ...tweet!, id: "501" },
		]);
		expect(payload.includes?.users).toHaveLength(1);
		expect(payload.data[0]).toMatchObject({
			conversation_id: "400",
			attachments: { media_keys: ["500:0", "500:1", "500:2"] },
			referenced_tweets: [
				{ type: "replied_to", id: "399" },
				{ type: "quoted", id: "398" },
			],
		});
	});

	it("uses fallback identity, safe defaults, custom account handles, and empty ingestion", () => {
		const home = getHome();
		expect(normalizeTwitter6551Tweet("not json")).toBeNull();
		expect(
			normalizeTwitter6551Tweet(
				{
					id: "600",
					text: null,
					createdAt: null,
					media: null,
					urls: null,
					mentions: null,
					hashtags: null,
				},
				{
					userId: "77",
					screenName: "fallback",
					name: "Fallback",
					followersCount: 9,
					verified: true,
				},
			),
		).toMatchObject({
			id: "600",
			text: "",
			userId: "77",
			userScreenName: "fallback",
			userName: "Fallback",
			userFollowers: 9,
			userVerified: true,
			media: [],
			urls: [],
			mentions: [],
			hashtags: [],
		});
		expect(ingestTwitter6551Tweets(home.db, "empty", [])).toEqual([]);
		expect(ensureTwitter6551Account(home.db)).toBe("acct_6551");
		expect(ensureTwitter6551Account(home.db, "custom bad/id")).toBe(
			"custom bad/id",
		);
		expect(
			home.db
				.prepare("select handle from accounts where id = ?")
				.get("custom bad/id"),
		).toEqual({ handle: "@custom_bad_id" });
	});

	it("reads runtime status shared by another production bundle", () => {
		const key = Symbol.for("birdclaw.twitter6551.runtime-status");
		const runtimeGlobal = globalThis as typeof globalThis &
			Record<symbol, unknown>;
		const original = runtimeGlobal[key] as ReturnType<
			typeof getTwitter6551RuntimeStatus
		>;
		const lastLocalHeartbeatAt = new Date().toISOString();
		runtimeGlobal[key] = {
			...original,
			enabled: true,
			state: "standby",
			failoverMode: true,
			activeSource: "local",
			lastLocalHeartbeatAt,
		};
		try {
			expect(getTwitter6551RuntimeStatus()).toMatchObject({
				enabled: true,
				state: "standby",
				failoverMode: true,
				activeSource: "local",
				lastLocalHeartbeatAt,
			});
		} finally {
			runtimeGlobal[key] = original;
			getTwitter6551RuntimeStatus();
		}
	});

	it("keeps 6551 on standby after a healthy local bridge heartbeat", async () => {
		process.env.BIRDCLAW_6551_ENABLED = "1";
		process.env.BIRDCLAW_6551_FAILOVER_MODE = "1";
		process.env.BIRDCLAW_6551_WATCH_USERS = "example";
		process.env.BIRDCLAW_LOCAL_STALE_SECONDS = "180";
		process.env.TWITTER_TOKEN = "secret-token";
		const now = new Date();

		await recordTwitter6551LocalHeartbeat(3, now);

		expect(getTwitter6551RuntimeStatus()).toMatchObject({
			enabled: true,
			state: "standby",
			activeSource: "local",
			lastLocalHeartbeatAt: now.toISOString(),
			localBridgeIngestedCount: 3,
		});
		await stopTwitter6551WorkerManager();
	});

	it("ingests idempotently into profiles, tweets, FTS, and the home timeline", () => {
		const home = getHome();
		const tweet = normalizeTwitter6551Tweet({
			id: "200",
			text: "durable event",
			createdAt: "2026-07-30T10:00:00Z",
			userIdStr: "84",
			userScreenName: "durable",
			userName: "Durable User",
			replyId: "199",
			favoriteCount: 3,
		})!;

		ingestTwitter6551Tweets(home.db, "acct_6551", [tweet]);
		ingestTwitter6551Tweets(home.db, "acct_6551", [
			{ ...tweet, text: "durable event updated", favoriteCount: 4 },
		]);

		expect(
			home.db.prepare("select count(*) as count from tweets").get(),
		).toEqual({ count: 1 });
		expect(
			home.db
				.prepare(
					"select text, like_count, is_replied from tweets where id = '200'",
				)
				.get(),
		).toEqual({
			text: "durable event updated",
			like_count: 4,
			is_replied: 0,
		});
		expect(
			home.db
				.prepare(
					"select count(*) as count from tweets_fts where tweet_id = '200'",
				)
				.get(),
		).toEqual({ count: 1 });
		expect(
			home.db
				.prepare(
					"select account_id, kind, source, seen_count from tweet_account_edges where tweet_id = '200'",
				)
				.get(),
		).toEqual({
			account_id: "acct_6551",
			kind: "home",
			source: "twitter6551",
			seen_count: 2,
		});
	});

	it("does not erase richer profile data when a tweet only has an author summary", () => {
		const home = getHome();
		home.db
			.prepare(
				`
				insert into profiles (
					id, handle, display_name, bio, followers_count, avatar_hue,
					public_metrics_json, entities_json, raw_json, created_at
				) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`,
			)
			.run(
				"profile_user_84",
				"durable",
				"Durable User",
				"valuable bio",
				999,
				10,
				JSON.stringify({ followers_count: 999 }),
				"{}",
				"{}",
				new Date().toISOString(),
			);
		const tweet = normalizeTwitter6551Tweet({
			id: "201",
			text: "summary-only author",
			createdAt: "2026-07-30T10:00:00Z",
			userIdStr: "84",
			userScreenName: "durable",
			userName: "Durable User",
		})!;

		ingestTwitter6551Tweets(home.db, "acct_6551", [tweet]);

		expect(
			home.db
				.prepare(
					"select bio, followers_count from profiles where id = 'profile_user_84'",
				)
				.get(),
		).toEqual({ bio: "valuable bio", followers_count: 999 });
	});

	it("uses bearer auth, parses the live envelope, and retries 429 once", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ success: false, message: "slow" }), {
					status: 429,
				}),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						success: true,
						data: {
							userId: "42",
							screenName: "example",
							name: "Example",
						},
					}),
					{ status: 200 },
				),
			);
		const sleep = vi.fn(async () => undefined);
		const client = new Twitter6551Client({
			token: "secret-token",
			fetchImpl,
			sleep,
		});

		await expect(client.getUser("example")).resolves.toMatchObject({
			userId: "42",
			screenName: "example",
		});
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledOnce();
		const request = fetchImpl.mock.calls[0]?.[1];
		expect(new Headers(request?.headers).get("authorization")).toBe(
			"Bearer secret-token",
		);
	});

	it("uses latest search for best-effort target conversation recovery", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					success: true,
					data: [
						{
							id: "reply_1",
							text: "target reply",
							createdAt: "2026-07-31T08:00:00.000Z",
							userIdStr: "42",
							userScreenName: "example",
							userName: "Example",
							conversationId: "target_1",
						},
					],
				}),
				{ status: 200 },
			),
		);
		const client = new Twitter6551Client({
			token: "secret-token",
			fetchImpl,
		});

		await expect(
			client.searchTweets("conversation_id:target_1", 100),
		).resolves.toMatchObject([{ id: "reply_1", conversationId: "target_1" }]);
		expect(
			JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)),
		).toMatchObject({
			keywords: "conversation_id:target_1",
			product: "Latest",
			excludeRetweets: true,
		});
	});

	it("covers every REST helper, result envelope, clamp, and permanent error path", async () => {
		expect(() => new Twitter6551Client({ token: " " })).toThrow(
			"6551 API token is missing",
		);
		const validTweet = {
			id: "700",
			text: "tweet",
			createdAt: "2026-08-10T00:00:00.000Z",
			userIdStr: "42",
			userScreenName: "example",
		};
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				Response.json({
					success: true,
					data: { userId: "42", screenName: "example", name: "Example" },
				}),
			)
			.mockResolvedValueOnce(
				Response.json({ success: true, data: [validTweet, null] }),
			)
			.mockResolvedValueOnce(Response.json({ success: true, data: validTweet }))
			.mockResolvedValueOnce(
				Response.json({ success: true, data: [validTweet, { nope: true }] }),
			)
			.mockResolvedValueOnce(
				Response.json({ success: true, data: "not-an-array" }),
			)
			.mockResolvedValueOnce(
				Response.json({ success: true, data: { watched: true } }),
			);
		const client = new Twitter6551Client({ token: "secret", fetchImpl });
		expect(await client.getUserTweets("@example", 0)).toHaveLength(1);
		expect(await client.getTweet("700")).toMatchObject({ id: "700" });
		expect(await client.getQuoteTweets("700", 999)).toHaveLength(1);
		expect(await client.searchTweets("anything", 3.9)).toEqual([]);
		await expect(client.addWatch("@example")).resolves.toEqual({
			watched: true,
		});
		const bodies = fetchImpl.mock.calls.map((call) =>
			JSON.parse(String(call[1]?.body)),
		);
		expect(bodies[1]).toMatchObject({
			maxResults: 1,
			includeReplies: true,
			includeRetweets: true,
		});
		expect(bodies[3]).toMatchObject({ maxResults: 100 });
		expect(bodies[4]).toMatchObject({ maxResults: 3, excludeRetweets: true });
		expect(bodies[5]).toMatchObject({
			username: "example",
			newTweetBol: true,
			updateNameBol: false,
		});

		const invalid = new Twitter6551Client({
			token: "secret",
			fetchImpl: vi
				.fn<typeof fetch>()
				.mockImplementation(async () =>
					Response.json({ success: true, data: null }),
				),
		});
		await expect(invalid.getUser("bad")).rejects.toThrow("invalid user");
		await expect(invalid.getTweet("bad")).rejects.toThrow("invalid tweet");

		const rejected = new Twitter6551Client({
			token: "secret",
			fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
				new Response(JSON.stringify({ success: false, msg: "bad request" }), {
					status: 400,
				}),
			),
		});
		await expect(rejected.getUser("bad")).rejects.toMatchObject({
			status: 400,
			message: "bad request",
		});
	});

	it("retries server and transport failures and preserves fallback error messages", async () => {
		const sleep = vi.fn(async () => undefined);
		const serverFetch = vi.fn<typeof fetch>().mockImplementation(
			async () =>
				new Response(JSON.stringify({ error: "upstream down" }), {
					status: 503,
				}),
		);
		await expect(
			new Twitter6551Client({
				token: "secret",
				fetchImpl: serverFetch,
				sleep,
			}).getUser("bad"),
		).rejects.toMatchObject({ status: 503, message: "upstream down" });
		expect(serverFetch).toHaveBeenCalledTimes(3);
		expect(sleep).toHaveBeenCalledTimes(2);

		const transportFetch = vi
			.fn<typeof fetch>()
			.mockRejectedValue("socket closed");
		await expect(
			new Twitter6551Client({
				token: "secret",
				fetchImpl: transportFetch,
				sleep,
			}).getUser("bad"),
		).rejects.toThrow("6551 request failed");
		expect(transportFetch).toHaveBeenCalledTimes(3);
		const errorFetch = vi
			.fn<typeof fetch>()
			.mockRejectedValue(new Error("network down"));
		await expect(
			new Twitter6551Client({
				token: "secret",
				fetchImpl: errorFetch,
				sleep,
			}).getUser("bad"),
		).rejects.toThrow("network down");

		const emptyError = new Twitter6551Client({
			token: "secret",
			fetchImpl: vi
				.fn<typeof fetch>()
				.mockImplementation(
					async () => new Response("not-json", { status: 418 }),
				),
		});
		await expect(emptyError.getUser("bad")).rejects.toThrow(
			"6551 request failed (418)",
		);

		const rawFetch = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				Response.json({ userId: "88", screenName: "raw_user", name: "Raw" }),
			);
		await expect(
			new Twitter6551Client({ token: "secret", fetchImpl: rawFetch }).getUser(
				"raw_user",
			),
		).resolves.toMatchObject({ userId: "88" });
	});

	it("normalizes runtime configuration from tokens, watch lists, and numeric fallbacks", () => {
		const keys = [
			"TWITTER_TOKEN",
			"OPENNEWS_TOKEN",
			"BIRDCLAW_6551_ENABLED",
			"BIRDCLAW_6551_WATCH_USERS",
			"BIRDCLAW_6551_TARGET_TWEETS",
			"BIRDCLAW_6551_ACCOUNT_ID",
			"BIRDCLAW_6551_BACKFILL_MINUTES",
			"BIRDCLAW_6551_REST_ONLY",
			"BIRDCLAW_6551_FAILOVER_MODE",
			"BIRDCLAW_LOCAL_STALE_SECONDS",
		];
		const before = Object.fromEntries(
			keys.map((key) => [key, process.env[key]]),
		);
		try {
			delete process.env.TWITTER_TOKEN;
			process.env.OPENNEWS_TOKEN = " fallback-token ";
			process.env.BIRDCLAW_6551_ENABLED = "1";
			process.env.BIRDCLAW_6551_WATCH_USERS = " @alice,alice,bob, ";
			process.env.BIRDCLAW_6551_TARGET_TWEETS = "10,10,20";
			process.env.BIRDCLAW_6551_ACCOUNT_ID = " custom ";
			process.env.BIRDCLAW_6551_BACKFILL_MINUTES = "bad";
			process.env.BIRDCLAW_6551_REST_ONLY = "1";
			process.env.BIRDCLAW_6551_FAILOVER_MODE = "1";
			process.env.BIRDCLAW_LOCAL_STALE_SECONDS = "90";
			expect(getTwitter6551RuntimeConfig()).toMatchObject({
				token: "fallback-token",
				enabled: true,
				accountId: "custom",
				watchUsers: ["alice", "bob"],
				targetTweetIds: ["10", "20"],
				restOnly: true,
				failoverMode: true,
				localStaleSeconds: 90,
			});
			process.env.BIRDCLAW_6551_WATCH_USERS = "";
			process.env.BIRDCLAW_6551_TARGET_TWEETS = "";
			expect(getTwitter6551RuntimeConfig().enabled).toBe(false);
		} finally {
			for (const key of keys) {
				const value = before[key];
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("refuses custom hosts before a token can be transmitted", () => {
		expect(
			() =>
				new Twitter6551Client({
					token: "secret-token",
					baseUrl: "https://evil.example",
				}),
		).toThrow("protect the API token");
	});

	it("runs configured REST-only recovery without Watch or WebSocket attempts", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-15T00:00:00.000Z"));
		const WebSocketMock = vi.fn();
		vi.stubGlobal("WebSocket", WebSocketMock);
		const client = {
			getUserTweets: vi.fn().mockResolvedValue([]),
			addWatch: vi.fn(),
		};
		const worker = new Twitter6551Worker(
			{
				baseUrl: "https://ai.6551.io",
				tokenEnv: "TWITTER_TOKEN",
				tokenDetected: true,
				token: "secret-token",
				enabled: true,
				accountId: "acct_rest_only",
				watchUsers: ["rest_only_user"],
				targetTweetIds: [],
				backfillMinutes: 1,
				restOnly: true,
				failoverMode: false,
				localStaleSeconds: 180,
			},
			client as never,
		);
		try {
			await worker.start();
			expect(client.getUserTweets).toHaveBeenCalledTimes(1);
			expect(client.addWatch).not.toHaveBeenCalled();
			expect(WebSocketMock).not.toHaveBeenCalled();
			expect(getTwitter6551RuntimeStatus()).toMatchObject({
				state: "polling",
				connected: false,
				lastBackfillAt: "2026-08-15T00:00:00.000Z",
				lastError: null,
			});

			await vi.advanceTimersByTimeAsync(60_000);
			expect(client.getUserTweets).toHaveBeenCalledTimes(2);
			expect(client.addWatch).not.toHaveBeenCalled();
			expect(WebSocketMock).not.toHaveBeenCalled();
		} finally {
			await worker.stop();
			vi.unstubAllGlobals();
			vi.useRealTimers();
		}
	});

	it("preserves the REST recovery due time across failover worker recreation", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-15T01:00:00.000Z"));
		const client = {
			getUserTweets: vi.fn().mockResolvedValue([]),
			addWatch: vi.fn(),
		};
		const config = {
			baseUrl: "https://ai.6551.io",
			tokenEnv: "TWITTER_TOKEN",
			tokenDetected: true,
			token: "secret-token",
			enabled: true,
			accountId: "acct_recovery_cooldown",
			watchUsers: ["cooldown_user"],
			targetTweetIds: [],
			backfillMinutes: 10,
			restOnly: true,
			failoverMode: true,
			localStaleSeconds: 180,
		};
		let worker = new Twitter6551Worker(config, client as never);
		try {
			await worker.start();
			expect(client.getUserTweets).toHaveBeenCalledTimes(1);
			const firstBackfillAt = getTwitter6551RuntimeStatus().lastBackfillAt;
			await worker.stop();

			vi.setSystemTime(new Date("2026-08-15T01:01:00.000Z"));
			worker = new Twitter6551Worker(config, client as never);
			await worker.start();
			expect(client.getUserTweets).toHaveBeenCalledTimes(1);
			expect(getTwitter6551RuntimeStatus()).toMatchObject({
				state: "polling",
				lastBackfillAt: firstBackfillAt,
				lastError: null,
			});

			await vi.advanceTimersByTimeAsync(8 * 60_000 + 59_999);
			expect(client.getUserTweets).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(client.getUserTweets).toHaveBeenCalledTimes(2);
			await worker.stop();

			vi.setSystemTime(new Date("2026-08-15T01:20:00.000Z"));
			worker = new Twitter6551Worker(config, client as never);
			await worker.start();
			expect(client.getUserTweets).toHaveBeenCalledTimes(3);
		} finally {
			await worker.stop();
			vi.useRealTimers();
		}
	});

	it("preserves REST-only errors through cooldown and clears them after recovery", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-15T02:00:00.000Z"));
		const client = {
			getUserTweets: vi
				.fn()
				.mockRejectedValueOnce(new Error("REST unavailable"))
				.mockResolvedValue([]),
			addWatch: vi.fn(),
		};
		const config = {
			baseUrl: "https://ai.6551.io",
			tokenEnv: "TWITTER_TOKEN",
			tokenDetected: true,
			token: "secret-token",
			enabled: true,
			accountId: "acct_recovery_error",
			watchUsers: ["recovery_error_user"],
			targetTweetIds: [],
			backfillMinutes: 10,
			restOnly: true,
			failoverMode: true,
			localStaleSeconds: 180,
		};
		let worker = new Twitter6551Worker(config, client as never);
		try {
			await worker.start();
			expect(getTwitter6551RuntimeStatus()).toMatchObject({
				state: "error",
				lastBackfillAt: null,
				lastError: "REST unavailable",
			});
			await worker.stop();

			vi.setSystemTime(new Date("2026-08-15T02:01:00.000Z"));
			worker = new Twitter6551Worker(config, client as never);
			await worker.start();
			expect(client.getUserTweets).toHaveBeenCalledTimes(1);
			expect(getTwitter6551RuntimeStatus()).toMatchObject({
				state: "error",
				lastError: "REST unavailable",
			});

			await vi.advanceTimersByTimeAsync(9 * 60_000);
			expect(client.getUserTweets).toHaveBeenCalledTimes(2);
			expect(getTwitter6551RuntimeStatus()).toMatchObject({
				state: "polling",
				lastBackfillAt: "2026-08-15T02:10:00.000Z",
				lastError: null,
			});
		} finally {
			await worker.stop();
			vi.useRealTimers();
		}
	});

	it("runs exactly one forced recovery per manual cold start despite cooldown", async () => {
		const keys = [
			"BIRDCLAW_6551_ENABLED",
			"BIRDCLAW_6551_ACCOUNT_ID",
			"BIRDCLAW_6551_WATCH_USERS",
			"BIRDCLAW_6551_TARGET_TWEETS",
			"BIRDCLAW_6551_REST_ONLY",
			"BIRDCLAW_6551_FAILOVER_MODE",
			"TWITTER_TOKEN",
		];
		const before = Object.fromEntries(
			keys.map((key) => [key, process.env[key]]),
		);
		const fetchMock = vi.fn<typeof fetch>(async (input) => {
			const url = String(input);
			return url.endsWith("/twitter_user_info")
				? Response.json({
						success: true,
						data: {
							userId: "cold-user-id",
							screenName: "cold_sync_user",
							name: "Cold Sync User",
						},
					})
				: Response.json({ success: true, data: [] });
		});
		try {
			await stopTwitter6551WorkerManager();
			process.env.BIRDCLAW_6551_ENABLED = "1";
			process.env.BIRDCLAW_6551_ACCOUNT_ID = "acct_cold_manual_sync";
			process.env.BIRDCLAW_6551_WATCH_USERS = "cold_sync_user";
			process.env.BIRDCLAW_6551_TARGET_TWEETS = "";
			process.env.BIRDCLAW_6551_REST_ONLY = "1";
			process.env.BIRDCLAW_6551_FAILOVER_MODE = "0";
			process.env.TWITTER_TOKEN = "secret-token";
			vi.stubGlobal("fetch", fetchMock);

			await runTwitter6551Backfill();

			expect(fetchMock).toHaveBeenCalledTimes(2);
			await stopTwitter6551WorkerManager();
			await runTwitter6551Backfill();

			expect(fetchMock).toHaveBeenCalledTimes(4);
			expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(
				Array.from({ length: 2 }).flatMap(() => [
					"https://ai.6551.io/open/twitter_user_info",
					"https://ai.6551.io/open/twitter_user_tweets",
				]),
			);
			expect(getTwitter6551RuntimeStatus()).toMatchObject({
				state: "polling",
				lastError: null,
			});
		} finally {
			await stopTwitter6551WorkerManager();
			vi.unstubAllGlobals();
			for (const key of keys) {
				const value = before[key];
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("reuses cooldown across a real local-to-6551 failover recreation", async () => {
		const keys = [
			"BIRDCLAW_6551_ENABLED",
			"BIRDCLAW_6551_ACCOUNT_ID",
			"BIRDCLAW_6551_WATCH_USERS",
			"BIRDCLAW_6551_TARGET_TWEETS",
			"BIRDCLAW_6551_BACKFILL_MINUTES",
			"BIRDCLAW_6551_REST_ONLY",
			"BIRDCLAW_6551_FAILOVER_MODE",
			"BIRDCLAW_LOCAL_STALE_SECONDS",
			"TWITTER_TOKEN",
		];
		const before = Object.fromEntries(
			keys.map((key) => [key, process.env[key]]),
		);
		const fetchMock = vi.fn<typeof fetch>(async (input) => {
			const url = String(input);
			return url.endsWith("/twitter_user_info")
				? Response.json({
						success: true,
						data: {
							userId: "manager-user-id",
							screenName: "manager_failover_user",
							name: "Manager Failover User",
						},
					})
				: Response.json({ success: true, data: [] });
		});
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-15T03:00:00.000Z"));
		try {
			await stopTwitter6551WorkerManager();
			process.env.BIRDCLAW_6551_ENABLED = "1";
			process.env.BIRDCLAW_6551_ACCOUNT_ID = "acct_manager_failover";
			process.env.BIRDCLAW_6551_WATCH_USERS = "manager_failover_user";
			process.env.BIRDCLAW_6551_TARGET_TWEETS = "";
			process.env.BIRDCLAW_6551_BACKFILL_MINUTES = "10";
			process.env.BIRDCLAW_6551_REST_ONLY = "1";
			process.env.BIRDCLAW_6551_FAILOVER_MODE = "1";
			process.env.BIRDCLAW_LOCAL_STALE_SECONDS = "1";
			process.env.TWITTER_TOKEN = "secret-token";
			vi.stubGlobal("fetch", fetchMock);

			await startTwitter6551WorkerManager();
			expect(fetchMock).not.toHaveBeenCalled();

			vi.setSystemTime(new Date("2026-08-15T03:00:01.001Z"));
			await startTwitter6551WorkerManager();
			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(getTwitter6551RuntimeStatus()).toMatchObject({
				state: "polling",
				activeSource: "6551",
			});

			await recordTwitter6551LocalHeartbeat(
				0,
				new Date("2026-08-15T03:00:02.000Z"),
			);
			expect(getTwitter6551RuntimeStatus()).toMatchObject({
				state: "standby",
				activeSource: "local",
			});

			vi.setSystemTime(new Date("2026-08-15T03:00:03.001Z"));
			await startTwitter6551WorkerManager();
			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(getTwitter6551RuntimeStatus()).toMatchObject({
				state: "polling",
				activeSource: "6551",
			});
		} finally {
			await stopTwitter6551WorkerManager();
			vi.unstubAllGlobals();
			vi.useRealTimers();
			for (const key of keys) {
				const value = before[key];
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("keeps recovery alive when watch preparation has a transient failure", async () => {
		const client = {
			addWatch: vi.fn().mockRejectedValue(new Error("temporary outage")),
		};
		const worker = new Twitter6551Worker(
			{
				baseUrl: "https://ai.6551.io",
				tokenEnv: "TWITTER_TOKEN",
				tokenDetected: true,
				token: "secret-token",
				enabled: true,
				accountId: "acct_6551",
				watchUsers: ["example"],
				targetTweetIds: [],
				backfillMinutes: 120,
				failoverMode: false,
				localStaleSeconds: 180,
			},
			client as never,
		);

		await expect(
			(
				worker as unknown as {
					prepareWatches(): Promise<void>;
				}
			).prepareWatches(),
		).resolves.toBeUndefined();
		expect(getTwitter6551RuntimeStatus()).toMatchObject({
			state: "degraded",
			connected: false,
		});
	});

	it("backfills watches, targets, duplicates, and plan-limited conversation helpers", async () => {
		const tweet = normalizeTwitter6551Tweet({
			id: "800",
			text: "backfill",
			createdAt: "2026-08-10T00:00:00.000Z",
			userIdStr: "80",
			userScreenName: "watched",
		})!;
		const client = {
			getUserTweets: vi.fn().mockResolvedValue([tweet]),
			getTweet: vi.fn().mockResolvedValue(tweet),
			searchTweets: vi
				.fn()
				.mockRejectedValue(new Twitter6551Error("not available", 400)),
			getQuoteTweets: vi
				.fn()
				.mockRejectedValue(new Twitter6551Error("plan", 403)),
			addWatch: vi.fn(),
		};
		const worker = new Twitter6551Worker(
			{
				baseUrl: "https://ai.6551.io",
				tokenEnv: "TWITTER_TOKEN",
				tokenDetected: true,
				token: "secret-token",
				enabled: true,
				accountId: "acct_6551",
				watchUsers: ["watched"],
				targetTweetIds: ["800"],
				backfillMinutes: 120,
				failoverMode: false,
				localStaleSeconds: 180,
			},
			client as never,
		);
		await worker.runBackfill();
		expect(client.getUserTweets).toHaveBeenCalledWith("watched", 100);
		expect(client.searchTweets).toHaveBeenCalledWith(
			"conversation_id:800",
			100,
		);
		expect(getTwitter6551RuntimeStatus()).toMatchObject({
			state: "degraded",
			lastBackfillAt: expect.any(String),
			lastError: null,
		});
	});

	it("records non-plan backfill failures and blocks overlapping backfills", async () => {
		let release: ((value: unknown[]) => void) | undefined;
		const client = {
			getUserTweets: vi.fn(
				() =>
					new Promise<unknown[]>((resolve) => {
						release = resolve;
					}),
			),
		};
		const config = {
			baseUrl: "https://ai.6551.io",
			tokenEnv: "TWITTER_TOKEN",
			tokenDetected: true,
			token: "secret-token",
			enabled: true,
			accountId: "acct_6551",
			watchUsers: ["watched"],
			targetTweetIds: [],
			backfillMinutes: 120,
			failoverMode: false,
			localStaleSeconds: 180,
		};
		const worker = new Twitter6551Worker(config, client as never);
		const first = worker.runBackfill();
		await vi.waitFor(() => expect(client.getUserTweets).toHaveBeenCalledOnce());
		await expect(worker.runBackfill()).resolves.toBe("skipped");
		release?.([]);
		await first;

		const failing = new Twitter6551Worker(
			{ ...config, watchUsers: [], targetTweetIds: ["bad"] },
			{
				getTweet: vi.fn().mockRejectedValue(new Error("target offline")),
			} as never,
		);
		await failing.runBackfill();
		expect(getTwitter6551RuntimeStatus()).toMatchObject({
			state: "error",
			lastError: "target offline",
		});
	});

	it("classifies watch-plan errors and accepts successful subscription control messages", async () => {
		const client = {
			addWatch: vi
				.fn()
				.mockRejectedValueOnce(new Twitter6551Error("already", 409))
				.mockRejectedValueOnce(new Twitter6551Error("bad", 400))
				.mockRejectedValueOnce(new Twitter6551Error("plan", 403)),
		};
		const worker = new Twitter6551Worker(
			{
				baseUrl: "https://ai.6551.io",
				tokenEnv: "TWITTER_TOKEN",
				tokenDetected: true,
				token: "secret-token",
				enabled: true,
				accountId: "acct_6551",
				watchUsers: ["one", "two", "three"],
				targetTweetIds: [],
				backfillMinutes: 120,
				failoverMode: false,
				localStaleSeconds: 180,
			},
			client as never,
		);
		await (
			worker as unknown as { prepareWatches(): Promise<void> }
		).prepareWatches();
		expect(getTwitter6551RuntimeStatus().lastError).toContain(
			"watch access is unavailable",
		);
		const send = vi.fn();
		const close = vi.fn();
		(worker as unknown as { socket: unknown }).socket = { send, close };
		const handle = (
			worker as unknown as { handleSocketMessage(raw: unknown): Promise<void> }
		).handleSocketMessage.bind(worker);
		await handle("ping");
		await handle("pong");
		await handle("not-json");
		await handle(
			JSON.stringify({ jsonrpc: "2.0", id: 1, result: { success: true } }),
		);
		expect(send).toHaveBeenCalledWith("pong");
		expect(getTwitter6551RuntimeStatus()).toMatchObject({
			connected: true,
			state: "degraded",
		});
		await worker.stop();
	});

	it("persists non-tweet events once and ignores malformed event envelopes", async () => {
		const home = getHome();
		const worker = new Twitter6551Worker({
			baseUrl: "https://ai.6551.io",
			tokenEnv: "TWITTER_TOKEN",
			tokenDetected: true,
			token: "secret-token",
			enabled: true,
			accountId: "acct_6551",
			watchUsers: ["allowed"],
			targetTweetIds: [],
			backfillMinutes: 120,
			failoverMode: false,
			localStaleSeconds: 180,
		});
		const handle = (
			worker as unknown as { handleSocketMessage(raw: unknown): Promise<void> }
		).handleSocketMessage.bind(worker);
		await handle({ method: "other" });
		await handle({ method: "twitter.event", params: null });
		const event = {
			method: "twitter.event",
			params: {
				id: "profile-change",
				eventType: "PROFILE_UPDATE",
				twAccount: "allowed",
				content: null,
			},
		};
		await handle(event);
		await handle(event);
		await handle({
			method: "twitter.event",
			params: {
				id: "valid-tweet",
				eventType: "NEW_TWEET",
				twAccount: "allowed",
				content: {
					id: "valid-tweet-id",
					text: "valid realtime tweet",
					userIdStr: "900",
					userScreenName: "allowed",
				},
			},
		});
		await handle({ method: "twitter.event", params: { content: null } });
		expect(
			home.db
				.prepare(
					"select count(*) as count from twitter6551_events where event_id = 'profile-change'",
				)
				.get(),
		).toEqual({ count: 1 });
		expect(
			home.db
				.prepare(
					"select processed_at, error from twitter6551_events where event_id = 'profile-change'",
				)
				.get(),
		).toEqual({ processed_at: expect.any(String), error: null });
		expect(
			home.db
				.prepare("select text from tweets where id = 'valid-tweet-id'")
				.get(),
		).toEqual({ text: "valid realtime tweet" });
	});

	it("rejects a failed WebSocket subscription acknowledgement", async () => {
		const worker = new Twitter6551Worker({
			baseUrl: "https://ai.6551.io",
			tokenEnv: "TWITTER_TOKEN",
			tokenDetected: true,
			token: "secret-token",
			enabled: true,
			accountId: "acct_6551",
			watchUsers: ["example"],
			targetTweetIds: [],
			backfillMinutes: 120,
			failoverMode: false,
			localStaleSeconds: 180,
		});
		const close = vi.fn();
		(
			worker as unknown as {
				socket: { close: typeof close };
			}
		).socket = { close };

		await (
			worker as unknown as {
				handleSocketMessage(raw: unknown): Promise<void>;
			}
		).handleSocketMessage(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				error: { code: 403, message: "plan does not permit realtime" },
			}),
		);

		expect(close).toHaveBeenCalledWith(1008, "subscription rejected");
		expect(getTwitter6551RuntimeStatus()).toMatchObject({
			state: "degraded",
			connected: false,
			lastError: expect.stringContaining("plan does not permit realtime"),
		});
	});

	it("starts, subscribes, reports socket lifecycle events, reconnects, and stops cleanly", async () => {
		class FakeWebSocket {
			static OPEN = 1;
			static instances: FakeWebSocket[] = [];
			readyState = FakeWebSocket.OPEN;
			listeners = new Map<string, Array<(event: any) => void>>();
			send = vi.fn();
			close = vi.fn();
			constructor(readonly url: string) {
				FakeWebSocket.instances.push(this);
			}
			addEventListener(name: string, listener: (event: any) => void) {
				const entries = this.listeners.get(name) ?? [];
				entries.push(listener);
				this.listeners.set(name, entries);
			}
			emit(name: string, event: any = {}) {
				for (const listener of this.listeners.get(name) ?? []) listener(event);
			}
		}
		vi.stubGlobal("WebSocket", FakeWebSocket);
		const worker = new Twitter6551Worker(
			{
				baseUrl: "https://ai.6551.io",
				tokenEnv: "TWITTER_TOKEN",
				tokenDetected: true,
				token: "secret-token",
				enabled: true,
				accountId: "acct_socket",
				watchUsers: [],
				targetTweetIds: [],
				backfillMinutes: 120,
				failoverMode: false,
				localStaleSeconds: 180,
			},
			{
				getUserTweets: vi.fn(),
				getTweet: vi.fn(),
				searchTweets: vi.fn(),
				getQuoteTweets: vi.fn(),
				addWatch: vi.fn(),
			} as never,
		);
		try {
			await worker.start();
			const socket = FakeWebSocket.instances[0];
			expect(socket?.url).toContain(
				"wss://ai.6551.io/open/twitter_wss?token=secret-token",
			);
			socket?.emit("open");
			expect(socket?.send).toHaveBeenCalledWith(
				expect.stringContaining("twitter.subscribe"),
			);
			socket?.emit("message", {
				data: JSON.stringify({ jsonrpc: "2.0", id: 1, result: true }),
			});
			await new Promise((resolve) => setImmediate(resolve));
			expect(getTwitter6551RuntimeStatus()).toMatchObject({
				connected: true,
				state: "connected",
			});
			socket?.emit("message", { data: "pong" });
			socket?.emit("error");
			expect(getTwitter6551RuntimeStatus()).toMatchObject({
				connected: false,
				state: "degraded",
				lastError: "6551 realtime connection failed",
			});
			socket?.emit("close", { code: 1008 });
			expect(getTwitter6551RuntimeStatus().reconnectCount).toBeGreaterThan(0);
		} finally {
			await worker.stop();
			vi.unstubAllGlobals();
		}
		expect(getTwitter6551RuntimeStatus()).toMatchObject({
			state: "stopped",
			connected: false,
		});
	});

	it("returns early for disabled and stopped workers and rejects subscription without detail", async () => {
		const config = {
			baseUrl: "https://ai.6551.io",
			tokenEnv: "TWITTER_TOKEN",
			tokenDetected: true,
			token: "secret-token",
			enabled: false,
			accountId: "acct_6551",
			watchUsers: [],
			targetTweetIds: [],
			backfillMinutes: 120,
			failoverMode: false,
			localStaleSeconds: 180,
		};
		const worker = new Twitter6551Worker(config, {} as never);
		await expect(worker.start()).resolves.toBeUndefined();
		await worker.stop();
		await expect(worker.start()).resolves.toBeUndefined();
		const close = vi.fn();
		(worker as unknown as { socket: unknown }).socket = { close };
		await (
			worker as unknown as { handleSocketMessage(raw: unknown): Promise<void> }
		).handleSocketMessage({ id: 1, result: false });
		expect(close).toHaveBeenCalledWith(1008, "subscription rejected");
		expect(getTwitter6551RuntimeStatus().lastError).toContain(
			"subscription was rejected",
		);
	});

	it("keeps malformed tweet events pending and ignores watches outside its allowlist", async () => {
		const home = getHome();
		const worker = new Twitter6551Worker({
			baseUrl: "https://ai.6551.io",
			tokenEnv: "TWITTER_TOKEN",
			tokenDetected: true,
			token: "secret-token",
			enabled: true,
			accountId: "acct_6551",
			watchUsers: ["allowed"],
			targetTweetIds: [],
			backfillMinutes: 120,
			failoverMode: false,
			localStaleSeconds: 180,
		});
		const persist = (
			worker as unknown as {
				persistAndProcessEvent(params: Record<string, unknown>): Promise<void>;
			}
		).persistAndProcessEvent.bind(worker);

		await persist({
			id: "malformed",
			eventType: "NEW_TWEET",
			twAccount: "allowed",
			content: { id: "300", text: "missing stable author id" },
		});
		await persist({
			id: "outside",
			eventType: "NEW_TWEET",
			twAccount: "somebody_else",
			content: {
				id: "301",
				text: "must not enter BirdClaw",
				userIdStr: "301",
				userScreenName: "somebody_else",
				userName: "Somebody Else",
			},
		});

		expect(
			home.db
				.prepare(
					"select processed_at, error from twitter6551_events where event_id = 'malformed'",
				)
				.get(),
		).toEqual({
			processed_at: null,
			error: "6551 tweet event could not be normalized",
		});
		expect(
			home.db
				.prepare(
					"select processed_at, error from twitter6551_events where event_id = 'outside'",
				)
				.get(),
		).toEqual({
			processed_at: expect.any(String),
			error: "ignored: watch user is not configured in BirdClaw",
		});
		expect(
			home.db.prepare("select count(*) as count from tweets").get(),
		).toEqual({ count: 0 });
	});
});
