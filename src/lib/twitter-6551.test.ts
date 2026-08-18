// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { useTestHome } from "../test/test-home";
import { ingestTweetPayload } from "./tweet-repository";
import {
	readTwitter6551DailyBudget,
	readTwitter6551FallbackState,
	recordTwitter6551FxRecovery,
	TWITTER6551_STATE_EVENT_PREFIX,
	TWITTER6551_STATE_EVENT_TYPE,
	TWITTER6551_STATE_WATCH_USER,
	twitter6551UsageDay,
	Twitter6551RequestBudgetError,
} from "./twitter-6551-state";
import {
	createBudgetedTwitter6551Client,
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

function fxTestStatus(id: string, overrides: Record<string, unknown> = {}) {
	return {
		type: "status",
		id,
		url: `https://x.com/free_recovery/status/${id}`,
		text: `free recovery ${id}`,
		created_at: "2026-08-15T00:00:00Z",
		likes: 1,
		reposts: 2,
		quotes: 3,
		replies: 4,
		author: {
			type: "profile",
			id: "fx-user-id",
			name: "Free Recovery",
			screen_name: "free_recovery",
		},
		raw_text: { text: `free recovery ${id}`, facets: [] },
		...overrides,
	};
}

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
			"BIRDCLAW_FXTWITTER_ENABLED",
			"BIRDCLAW_FXTWITTER_BACKFILL_MINUTES",
			"BIRDCLAW_6551_PAID_FALLBACK_FAILURE_THRESHOLD",
			"BIRDCLAW_6551_PAID_FALLBACK_COOLDOWN_MINUTES",
			"BIRDCLAW_6551_PAID_DAILY_REQUEST_BUDGET",
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
			delete process.env.BIRDCLAW_FXTWITTER_ENABLED;
			expect(getTwitter6551RuntimeConfig()).toMatchObject({
				token: "fallback-token",
				enabled: true,
				paidEnabled: true,
				fxtwitterEnabled: false,
				provider: "6551",
				accountId: "custom",
				watchUsers: ["alice", "bob"],
				targetTweetIds: ["10", "20"],
				restOnly: true,
				failoverMode: true,
				localStaleSeconds: 90,
				paidFallbackFailureThreshold: 3,
				paidFallbackCooldownMinutes: 360,
				paidDailyRequestBudget: 24,
			});

			process.env.BIRDCLAW_6551_PAID_DAILY_REQUEST_BUDGET = "invalid";
			process.env.BIRDCLAW_6551_PAID_FALLBACK_FAILURE_THRESHOLD = "-1";
			process.env.BIRDCLAW_6551_PAID_FALLBACK_COOLDOWN_MINUTES = "invalid";
			expect(getTwitter6551RuntimeConfig()).toMatchObject({
				paidDailyRequestBudget: 0,
				paidFallbackFailureThreshold: Number.MAX_SAFE_INTEGER,
				paidFallbackCooldownMinutes: Number.MAX_SAFE_INTEGER,
			});
			delete process.env.BIRDCLAW_6551_PAID_DAILY_REQUEST_BUDGET;
			delete process.env.BIRDCLAW_6551_PAID_FALLBACK_FAILURE_THRESHOLD;
			delete process.env.BIRDCLAW_6551_PAID_FALLBACK_COOLDOWN_MINUTES;
			process.env.BIRDCLAW_FXTWITTER_ENABLED = "1";
			process.env.BIRDCLAW_FXTWITTER_BACKFILL_MINUTES = "30";
			expect(getTwitter6551RuntimeConfig()).toMatchObject({
				enabled: true,
				paidEnabled: true,
				fxtwitterEnabled: true,
				provider: "fxtwitter",
				backfillMinutes: 30,
				restOnly: true,
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

	it("uses free FxTwitter targeted recovery without any paid 6551 or WebSocket calls", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-15T00:00:00.000Z"));
		const WebSocketMock = vi.fn();
		vi.stubGlobal("WebSocket", WebSocketMock);
		const paidClient = {
			addWatch: vi.fn(),
			getUserTweets: vi.fn(),
			getTweet: vi.fn(),
			searchTweets: vi.fn(),
			getQuoteTweets: vi.fn(),
		};
		const fxtwitter = {
			getProfileStatuses: vi.fn().mockResolvedValue({
				code: 200,
				results: [fxTestStatus("fx-watch")],
				cursor: null,
			}),
			getStatus: vi.fn().mockResolvedValue({
				code: 200,
				status: fxTestStatus("fx-target"),
				thread: [],
			}),
			getConversation: vi.fn().mockResolvedValue({
				code: 200,
				status: fxTestStatus("fx-target"),
				thread: [],
				replies: [fxTestStatus("fx-reply", { conversation_id: "fx-target" })],
				cursor: null,
			}),
			getQuotes: vi.fn().mockResolvedValue({
				code: 200,
				results: [fxTestStatus("fx-quote")],
				cursor: null,
			}),
		};
		const worker = new Twitter6551Worker(
			{
				baseUrl: "https://ai.6551.io",
				tokenEnv: "TWITTER_TOKEN",
				tokenDetected: false,
				token: "",
				enabled: true,
				accountId: "acct_fx_recovery",
				watchUsers: ["free_recovery"],
				targetTweetIds: ["fx-target"],
				backfillMinutes: 30,
				restOnly: true,
				paidEnabled: false,
				fxtwitterEnabled: true,
				provider: "fxtwitter",
				failoverMode: false,
				localStaleSeconds: 180,
			},
			paidClient as never,
			fxtwitter as never,
		);
		try {
			await worker.start();
			expect(fxtwitter.getProfileStatuses).toHaveBeenCalledWith(
				"free_recovery",
				{ count: 100, withReplies: true },
			);
			expect(fxtwitter.getStatus).toHaveBeenCalledWith("fx-target");
			expect(fxtwitter.getConversation).toHaveBeenCalledWith("fx-target", {
				rankingMode: "recency",
			});
			expect(fxtwitter.getQuotes).toHaveBeenCalledWith("fx-target", {
				count: 100,
			});
			for (const method of Object.values(paidClient)) {
				expect(method).not.toHaveBeenCalled();
			}
			expect(WebSocketMock).not.toHaveBeenCalled();
			expect(getTwitter6551RuntimeStatus()).toMatchObject({
				provider: "fxtwitter",
				activeSource: "fxtwitter",
				state: "polling",
				lastError: null,
			});
			expect(
				getHome()
					.db.prepare(
						"select tweet_id, source from tweet_account_edges where account_id = ? order by tweet_id",
					)
					.all("acct_fx_recovery"),
			).toEqual([
				{ tweet_id: "fx-quote", source: "fxtwitter" },
				{ tweet_id: "fx-reply", source: "fxtwitter" },
				{ tweet_id: "fx-target", source: "fxtwitter" },
				{ tweet_id: "fx-watch", source: "fxtwitter" },
			]);
			expect(
				getHome()
					.db.prepare("select name, transport from accounts where id = ?")
					.get("acct_fx_recovery"),
			).toEqual({ name: "FxTwitter Recovery", transport: "fxtwitter" });
		} finally {
			await worker.stop();
			vi.unstubAllGlobals();
			vi.useRealTimers();
		}
	});

	it("ingests successful FxTwitter targets when another target fails", async () => {
		const paidClient = {
			addWatch: vi.fn(),
			getUserTweets: vi.fn(),
		};
		const fxtwitter = {
			getProfileStatuses: vi.fn(async (handle: string) => {
				if (handle === "broken") throw new Error("profile unavailable");
				return {
					code: 200,
					results: [fxTestStatus("fx-partial")],
					cursor: null,
				};
			}),
		};
		const worker = new Twitter6551Worker(
			{
				baseUrl: "https://ai.6551.io",
				tokenEnv: "TWITTER_TOKEN",
				tokenDetected: false,
				token: "",
				enabled: true,
				accountId: "acct_fx_partial",
				watchUsers: ["healthy", "broken"],
				targetTweetIds: [],
				backfillMinutes: 30,
				restOnly: true,
				paidEnabled: false,
				fxtwitterEnabled: true,
				provider: "fxtwitter",
				failoverMode: false,
				localStaleSeconds: 180,
			},
			paidClient as never,
			fxtwitter as never,
		);
		try {
			await worker.start();
			expect(fxtwitter.getProfileStatuses).toHaveBeenCalledTimes(2);
			expect(
				getHome()
					.db.prepare(
						"select source from tweet_account_edges where account_id = ? and tweet_id = ?",
					)
					.get("acct_fx_partial", "fx-partial"),
			).toEqual({ source: "fxtwitter" });
			expect(getTwitter6551RuntimeStatus()).toMatchObject({
				provider: "fxtwitter",
				state: "degraded",
				lastError: expect.stringContaining("@broken: profile unavailable"),
			});
			expect(getTwitter6551RuntimeStatus().lastBackfillAt).not.toBeNull();
			expect(paidClient.getUserTweets).not.toHaveBeenCalled();
		} finally {
			await worker.stop();
		}
	});

	it("still ingests free Fx success when corrupt paid state is blocked", async () => {
		const home = getHome();
		const now = new Date().toISOString();
		home.db
			.prepare(
				`insert into twitter6551_events (
					event_id, event_type, watch_user, tweet_id, raw_json,
					received_at, processed_at, error
				 ) values (?, ?, ?, null, ?, ?, ?, null)`,
			)
			.run(
				`${TWITTER6551_STATE_EVENT_PREFIX}fallback:acct_fx_corrupt_paid_state`,
				TWITTER6551_STATE_EVENT_TYPE,
				TWITTER6551_STATE_WATCH_USER,
				JSON.stringify({
					version: 1,
					kind: "fallback_state",
					accountId: "acct_fx_corrupt_paid_state",
					scope: JSON.stringify({
						provider: "fxtwitter",
						accountId: "acct_fx_corrupt_paid_state",
						watchUsers: ["free_recovery"],
						targetTweetIds: [],
					}),
					consecutiveFxTotalFailures: "corrupt",
					lastCountedFxFailureAt: null,
					lastPaidFallbackAt: null,
				}),
				now,
				now,
			);
		const paidClient = { getUserTweets: vi.fn() };
		const fxtwitter = {
			getProfileStatuses: vi.fn().mockResolvedValue({
				code: 200,
				results: [fxTestStatus("fx-survives-corrupt-paid-state")],
				cursor: null,
			}),
		};
		const worker = new Twitter6551Worker(
			{
				baseUrl: "https://ai.6551.io",
				tokenEnv: "TWITTER_TOKEN",
				tokenDetected: true,
				token: "secret-token",
				enabled: true,
				accountId: "acct_fx_corrupt_paid_state",
				watchUsers: ["free_recovery"],
				targetTweetIds: [],
				backfillMinutes: 30,
				paidEnabled: true,
				fxtwitterEnabled: true,
				provider: "fxtwitter",
				failoverMode: false,
				localStaleSeconds: 180,
				paidFallbackFailureThreshold: 3,
				paidFallbackCooldownMinutes: 360,
				paidDailyRequestBudget: 24,
			},
			paidClient as never,
			fxtwitter as never,
		);
		try {
			await expect(worker.runBackfill()).resolves.toBe("partial");
			expect(paidClient.getUserTweets).not.toHaveBeenCalled();
			expect(
				home.db
					.prepare("select text from tweets where id = ?")
					.get("fx-survives-corrupt-paid-state"),
			).toEqual({ text: "free recovery fx-survives-corrupt-paid-state" });
			expect(getTwitter6551RuntimeStatus().lastError).toContain(
				"paid fallback state remains blocked",
			);
		} finally {
			await worker.stop();
		}
	});

	it("uses paid REST only after persisted consecutive Fx total failures and keeps cooldown across worker recreation", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-15T00:00:00.000Z"));
		const WebSocketMock = vi.fn();
		vi.stubGlobal("WebSocket", WebSocketMock);
		const paidTweet = normalizeTwitter6551Tweet({
			id: "paid-reserve-tweet",
			text: "paid reserve",
			createdAt: "2026-08-15T00:00:00.000Z",
			userIdStr: "paid-user",
			userScreenName: "paid_user",
		})!;
		const paidClient = {
			getUserTweets: vi.fn().mockResolvedValue([paidTweet]),
			addWatch: vi.fn(),
		};
		const failingFx = () => ({
			getProfileStatuses: vi.fn().mockRejectedValue(new Error("Fx offline")),
		});
		const config = {
			baseUrl: "https://ai.6551.io",
			tokenEnv: "TWITTER_TOKEN",
			tokenDetected: true,
			token: "secret-token",
			enabled: true,
			accountId: "acct_three_tier",
			watchUsers: ["three_tier_user"],
			targetTweetIds: [],
			backfillMinutes: 1,
			restOnly: false,
			paidEnabled: true,
			fxtwitterEnabled: true,
			provider: "fxtwitter" as const,
			failoverMode: false,
			localStaleSeconds: 180,
			paidFallbackFailureThreshold: 3,
			paidFallbackCooldownMinutes: 360,
			paidDailyRequestBudget: 24,
		};
		let worker = new Twitter6551Worker(
			config,
			paidClient as never,
			failingFx() as never,
		);
		try {
			await worker.runBackfill();
			expect(paidClient.getUserTweets).not.toHaveBeenCalled();
			vi.setSystemTime(new Date("2026-08-15T00:01:00.000Z"));
			await worker.runBackfill();
			expect(paidClient.getUserTweets).not.toHaveBeenCalled();
			vi.setSystemTime(new Date("2026-08-15T00:02:00.000Z"));
			await worker.runBackfill();
			expect(paidClient.getUserTweets).toHaveBeenCalledTimes(1);
			expect(getTwitter6551RuntimeStatus()).toMatchObject({
				provider: "fxtwitter",
				activeSource: "6551",
				state: "degraded",
				fxConsecutiveTotalFailures: 0,
				lastPaidFallbackAt: "2026-08-15T00:02:00.000Z",
			});
			expect(paidClient.addWatch).not.toHaveBeenCalled();
			expect(WebSocketMock).not.toHaveBeenCalled();
			await worker.stop();

			worker = new Twitter6551Worker(
				config,
				paidClient as never,
				failingFx() as never,
			);
			for (const minute of [3, 4, 5]) {
				vi.setSystemTime(new Date(`2026-08-15T00:0${String(minute)}:00.000Z`));
				await worker.runBackfill();
			}
			expect(paidClient.getUserTweets).toHaveBeenCalledTimes(1);
			expect(
				readTwitter6551FallbackState(
					getHome().db,
					config.accountId,
					JSON.stringify({
						provider: "fxtwitter",
						accountId: config.accountId,
						watchUsers: config.watchUsers,
						targetTweetIds: config.targetTweetIds,
					}),
				),
			).toMatchObject({ consecutiveFxTotalFailures: 3 });

			vi.setSystemTime(new Date("2026-08-15T06:02:00.000Z"));
			await worker.runBackfill();
			expect(paidClient.getUserTweets).toHaveBeenCalledTimes(2);
		} finally {
			await worker.stop();
			vi.unstubAllGlobals();
			vi.useRealTimers();
		}
	});

	it("resets the paid threshold on Fx partial success", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-15T07:00:00.000Z"));
		const paidClient = { getUserTweets: vi.fn() };
		const fxtwitter = {
			getProfileStatuses: vi
				.fn()
				.mockRejectedValueOnce(new Error("Fx offline"))
				.mockRejectedValueOnce(new Error("Fx offline"))
				.mockRejectedValueOnce(new Error("Fx offline"))
				.mockRejectedValueOnce(new Error("Fx offline"))
				.mockImplementationOnce(async (handle: string) => {
					if (handle === "broken") throw new Error("one target offline");
					return {
						code: 200,
						results: [fxTestStatus("fx-resets-threshold")],
						cursor: null,
					};
				})
				.mockRejectedValue(new Error("Fx offline")),
		};
		const config = {
			baseUrl: "https://ai.6551.io",
			tokenEnv: "TWITTER_TOKEN",
			tokenDetected: true,
			token: "secret-token",
			enabled: true,
			accountId: "acct_fx_reset",
			watchUsers: ["healthy", "broken"],
			targetTweetIds: [],
			backfillMinutes: 1,
			paidEnabled: true,
			fxtwitterEnabled: true,
			provider: "fxtwitter" as const,
			failoverMode: false,
			localStaleSeconds: 180,
			paidFallbackFailureThreshold: 3,
			paidFallbackCooldownMinutes: 360,
			paidDailyRequestBudget: 24,
		};
		const worker = new Twitter6551Worker(
			config,
			paidClient as never,
			fxtwitter as never,
		);
		try {
			await worker.runBackfill();
			vi.setSystemTime(new Date("2026-08-15T07:01:00.000Z"));
			await worker.runBackfill();
			vi.setSystemTime(new Date("2026-08-15T07:02:00.000Z"));
			await worker.runBackfill();
			expect(getTwitter6551RuntimeStatus()).toMatchObject({
				state: "degraded",
				fxConsecutiveTotalFailures: 0,
			});
			expect(paidClient.getUserTweets).not.toHaveBeenCalled();
		} finally {
			await worker.stop();
			vi.useRealTimers();
		}
	});

	it("counts every paid retry and blocks the network at the persistent daily limit", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () =>
			Response.json({ success: false, message: "retry" }, { status: 503 }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const config = {
			...getTwitter6551RuntimeConfig(),
			token: "secret-token",
			paidDailyRequestBudget: 2,
		};
		const client = createBudgetedTwitter6551Client(config);
		try {
			await expect(client.getUser("budget_user")).rejects.toThrow(
				"daily request budget exhausted",
			);
			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(
				readTwitter6551DailyBudget(getHome().db, 2, new Date()),
			).toMatchObject({ attempts: 2, remaining: 0 });

			const recreated = createBudgetedTwitter6551Client(config);
			await expect(recreated.getUser("budget_user")).rejects.toThrow(
				"daily request budget exhausted",
			);
			expect(fetchMock).toHaveBeenCalledTimes(2);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("serializes concurrent paid attempts so only one reaches the network", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () =>
			Response.json({
				userId: "88",
				screenName: "budget_user",
				name: "Budget",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const config = {
			...getTwitter6551RuntimeConfig(),
			token: "secret-token",
			paidDailyRequestBudget: 1,
		};
		try {
			const results = await Promise.allSettled([
				createBudgetedTwitter6551Client(config).getUser("first"),
				createBudgetedTwitter6551Client(config).getUser("second"),
			]);
			expect(results.map((result) => result.status).sort()).toEqual([
				"fulfilled",
				"rejected",
			]);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(
				readTwitter6551DailyBudget(getHome().db, 1, new Date()),
			).toMatchObject({ attempts: 1, remaining: 0 });
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("blocks the network when a legacy v18 budget row is corrupt", async () => {
		const home = getHome();
		home.db.exec(`
			create table twitter6551_paid_daily_usage (
				usage_day text primary key,
				request_attempts integer not null default 0
					check (request_attempts >= 0),
				updated_at text not null
			);
		`);
		home.db
			.prepare(
				`insert into twitter6551_paid_daily_usage
				 (usage_day, request_attempts, updated_at) values (?, ?, ?)`,
			)
			.run(twitter6551UsageDay(), "corrupt", new Date().toISOString());
		const fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetchMock);
		const config = {
			...getTwitter6551RuntimeConfig(),
			token: "secret-token",
			paidDailyRequestBudget: 24,
		};
		try {
			await expect(
				createBudgetedTwitter6551Client(config).getUser("blocked"),
			).rejects.toThrow("budget could not be verified");
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("blocks the network when a v18 database is missing its legacy budget table", async () => {
		const home = getHome();
		home.db.exec("pragma user_version = 18");
		const fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetchMock);
		const config = {
			...getTwitter6551RuntimeConfig(),
			token: "secret-token",
			paidDailyRequestBudget: 24,
		};
		try {
			await expect(
				createBudgetedTwitter6551Client(config).getUser("blocked-missing"),
			).rejects.toThrow("budget could not be verified");
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("ingests paid partial results fill-only before a later budget stop", async () => {
		const home = getHome();
		const paidTweet = normalizeTwitter6551Tweet({
			id: "paid-partial-existing",
			text: "lower-priority paid text",
			createdAt: "2026-08-15T09:00:00.000Z",
			userIdStr: "paid-partial-user",
			userScreenName: "paid_partial_user",
		})!;
		ingestTweetPayload(home.db, {
			accountId: "acct_paid_partial",
			payload: {
				data: [
					{
						id: paidTweet.id,
						author_id: "bird-paid-partial-user",
						text: "authenticated bird text",
						created_at: "2026-08-15T08:59:00.000Z",
					},
				],
				includes: {
					users: [
						{
							id: "bird-paid-partial-user",
							name: "Bird Source",
							username: "bird_source",
						},
					],
				},
				meta: { result_count: 1 },
			},
			source: "bird",
			edgeKind: "home",
		});
		const paidClient = {
			getUserTweets: vi.fn(async (handle: string) => {
				if (handle === "budget-blocked") {
					throw new Twitter6551RequestBudgetError("budget boundary");
				}
				return [paidTweet];
			}),
		};
		const fxtwitter = {
			getProfileStatuses: vi.fn().mockRejectedValue(new Error("Fx offline")),
		};
		const worker = new Twitter6551Worker(
			{
				baseUrl: "https://ai.6551.io",
				tokenEnv: "TWITTER_TOKEN",
				tokenDetected: true,
				token: "secret-token",
				enabled: true,
				accountId: "acct_paid_partial",
				watchUsers: ["paid-success", "budget-blocked"],
				targetTweetIds: [],
				backfillMinutes: 1,
				paidEnabled: true,
				fxtwitterEnabled: true,
				provider: "fxtwitter",
				failoverMode: false,
				localStaleSeconds: 180,
				paidFallbackFailureThreshold: 1,
				paidFallbackCooldownMinutes: 360,
				paidDailyRequestBudget: 24,
			},
			paidClient as never,
			fxtwitter as never,
		);
		try {
			await expect(worker.runBackfill()).resolves.toBe("partial");
			expect(paidClient.getUserTweets).toHaveBeenCalledTimes(2);
			expect(
				home.db
					.prepare("select text, created_at from tweets where id = ?")
					.get(paidTweet.id),
			).toEqual({
				text: "authenticated bird text",
				created_at: "2026-08-15T08:59:00.000Z",
			});
			expect(getTwitter6551RuntimeStatus()).toMatchObject({
				activeSource: "6551",
				state: "degraded",
				lastError: expect.stringContaining("budget boundary"),
			});
		} finally {
			await worker.stop();
		}
	});

	it("suppresses the rest of a paid batch before budget when local heartbeat recovers", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-15T10:00:00.000Z"));
		await recordTwitter6551LocalHeartbeat(
			0,
			new Date("2000-01-01T00:00:00.000Z"),
		);
		const fetchMock = vi.fn<typeof fetch>(async (input) => {
			expect(String(input)).toBe("https://ai.6551.io/open/twitter_tweet_by_id");
			await recordTwitter6551LocalHeartbeat(0, new Date());
			return Response.json({
				success: true,
				data: {
					id: "local-return-tweet",
					text: "result fetched before local return",
					createdAt: "2026-08-15T10:02:00.000Z",
					userIdStr: "local-return-user",
					userScreenName: "local_return_user",
				},
			});
		});
		vi.stubGlobal("fetch", fetchMock);
		const fxtwitter = {
			getStatus: vi.fn().mockRejectedValue(new Error("Fx offline")),
			getConversation: vi.fn().mockRejectedValue(new Error("Fx offline")),
			getQuotes: vi.fn().mockRejectedValue(new Error("Fx offline")),
		};
		const config = {
			baseUrl: "https://ai.6551.io",
			tokenEnv: "TWITTER_TOKEN",
			tokenDetected: true,
			token: "secret-token",
			enabled: true,
			accountId: "acct_local_return",
			watchUsers: [],
			targetTweetIds: ["local-return-tweet"],
			backfillMinutes: 1,
			paidEnabled: true,
			fxtwitterEnabled: true,
			provider: "fxtwitter" as const,
			failoverMode: true,
			localStaleSeconds: 180,
			paidFallbackFailureThreshold: 3,
			paidFallbackCooldownMinutes: 360,
			paidDailyRequestBudget: 24,
		};
		const worker = new Twitter6551Worker(config, undefined, fxtwitter as never);
		try {
			for (const minute of [0, 1, 2]) {
				vi.setSystemTime(new Date(`2026-08-15T10:0${String(minute)}:00.000Z`));
				await worker.runBackfill();
			}
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(
				readTwitter6551DailyBudget(
					getHome().db,
					24,
					new Date("2026-08-15T10:02:00.000Z"),
				),
			).toMatchObject({ attempts: 1, remaining: 23 });
			expect(getTwitter6551RuntimeStatus().lastError).toContain(
				"local BirdClaw bridge recovered",
			);
			expect(
				getHome()
					.db.prepare("select text from tweets where id = ?")
					.get("local-return-tweet"),
			).toEqual({ text: "result fetched before local return" });
		} finally {
			await worker.stop();
			await recordTwitter6551LocalHeartbeat(
				0,
				new Date("2000-01-01T00:00:00.000Z"),
			);
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

	it("keeps cold and hot manual free syncs off paid even when the stored threshold is already met", async () => {
		const keys = [
			"BIRDCLAW_FXTWITTER_ENABLED",
			"BIRDCLAW_FXTWITTER_BACKFILL_MINUTES",
			"BIRDCLAW_6551_ENABLED",
			"BIRDCLAW_6551_ACCOUNT_ID",
			"BIRDCLAW_6551_WATCH_USERS",
			"BIRDCLAW_6551_TARGET_TWEETS",
			"BIRDCLAW_6551_FAILOVER_MODE",
			"BIRDCLAW_6551_PAID_FALLBACK_FAILURE_THRESHOLD",
			"TWITTER_TOKEN",
		];
		const before = Object.fromEntries(
			keys.map((key) => [key, process.env[key]]),
		);
		const fetchMock = vi.fn<typeof fetch>(async (input) => {
			const url = String(input);
			if (url.startsWith("https://ai.6551.io/")) {
				throw new Error("paid network must not be called");
			}
			return Response.json(
				{ code: 404, message: "Fx unavailable" },
				{ status: 404 },
			);
		});
		try {
			await stopTwitter6551WorkerManager();
			process.env.BIRDCLAW_FXTWITTER_ENABLED = "1";
			process.env.BIRDCLAW_FXTWITTER_BACKFILL_MINUTES = "30";
			process.env.BIRDCLAW_6551_ENABLED = "1";
			process.env.BIRDCLAW_6551_ACCOUNT_ID = "acct_manual_free_guard";
			process.env.BIRDCLAW_6551_WATCH_USERS = "manual_free_guard";
			process.env.BIRDCLAW_6551_TARGET_TWEETS = "";
			process.env.BIRDCLAW_6551_FAILOVER_MODE = "0";
			process.env.BIRDCLAW_6551_PAID_FALLBACK_FAILURE_THRESHOLD = "3";
			process.env.TWITTER_TOKEN = "secret-token";
			vi.stubGlobal("fetch", fetchMock);

			const scope = JSON.stringify({
				provider: "fxtwitter",
				accountId: "acct_manual_free_guard",
				watchUsers: ["manual_free_guard"],
				targetTweetIds: [],
			});
			for (let index = 0; index < 3; index += 1) {
				recordTwitter6551FxRecovery(
					getHome().db,
					"acct_manual_free_guard",
					scope,
					"total_failure",
					new Date(Date.now() + index),
				);
			}

			await runTwitter6551Backfill();
			await runTwitter6551Backfill();

			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(
				fetchMock.mock.calls.every(([input]) =>
					String(input).startsWith("https://api.fxtwitter.com/"),
				),
			).toBe(true);
			expect(
				readTwitter6551FallbackState(
					getHome().db,
					"acct_manual_free_guard",
					scope,
				),
			).toMatchObject({ consecutiveFxTotalFailures: 3 });
			expect(readTwitter6551DailyBudget(getHome().db, 24).attempts).toBe(0);
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

	it("allows one free manual FxTwitter sync while the authenticated local bridge is fresh", async () => {
		const keys = [
			"BIRDCLAW_FXTWITTER_ENABLED",
			"BIRDCLAW_FXTWITTER_BACKFILL_MINUTES",
			"BIRDCLAW_6551_ENABLED",
			"BIRDCLAW_6551_ACCOUNT_ID",
			"BIRDCLAW_6551_WATCH_USERS",
			"BIRDCLAW_6551_TARGET_TWEETS",
			"BIRDCLAW_6551_FAILOVER_MODE",
			"BIRDCLAW_LOCAL_STALE_SECONDS",
			"TWITTER_TOKEN",
			"OPENNEWS_TOKEN",
		];
		const before = Object.fromEntries(
			keys.map((key) => [key, process.env[key]]),
		);
		const fetchMock = vi.fn<typeof fetch>(async () =>
			Response.json({
				code: 200,
				results: [fxTestStatus("fx-manual")],
				cursor: null,
			}),
		);
		try {
			await stopTwitter6551WorkerManager();
			process.env.BIRDCLAW_FXTWITTER_ENABLED = "1";
			process.env.BIRDCLAW_FXTWITTER_BACKFILL_MINUTES = "30";
			process.env.BIRDCLAW_6551_ENABLED = "0";
			process.env.BIRDCLAW_6551_ACCOUNT_ID = "acct_fx_manual";
			process.env.BIRDCLAW_6551_WATCH_USERS = "free_recovery";
			process.env.BIRDCLAW_6551_TARGET_TWEETS = "";
			process.env.BIRDCLAW_6551_FAILOVER_MODE = "1";
			process.env.BIRDCLAW_LOCAL_STALE_SECONDS = "180";
			delete process.env.TWITTER_TOKEN;
			delete process.env.OPENNEWS_TOKEN;
			vi.stubGlobal("fetch", fetchMock);
			const home = getHome();
			ensureTwitter6551Account(home.db, "acct_fx_manual");
			home.db
				.prepare(
					"update accounts set name = 'Primary', transport = 'bird' where id = ?",
				)
				.run("acct_fx_manual");
			ingestTweetPayload(home.db, {
				accountId: "acct_fx_manual",
				payload: {
					data: [
						{
							id: "fx-manual",
							author_id: "bird-user-id",
							text: "authenticated bird text",
							created_at: "2026-08-14T12:00:00.000Z",
							public_metrics: { like_count: 99 },
							entities: { urls: [], mentions: [], hashtags: [] },
						},
					],
					includes: {
						users: [
							{
								id: "bird-user-id",
								name: "Authenticated Bird",
								username: "authenticated_bird",
							},
						],
					},
					meta: { result_count: 1 },
				},
				source: "bird",
				edgeKind: "home",
			});

			await recordTwitter6551LocalHeartbeat(0, new Date());
			expect(getTwitter6551RuntimeStatus()).toMatchObject({
				provider: "fxtwitter",
				activeSource: "local",
			});

			await runTwitter6551Backfill();

			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
				"https://api.fxtwitter.com/2/profile/free_recovery/statuses?count=100&with_replies=true",
			);
			expect(getTwitter6551RuntimeStatus()).toMatchObject({
				provider: "fxtwitter",
				activeSource: "fxtwitter",
				state: "polling",
				lastError: null,
			});
			expect(
				home.db
					.prepare(
						`select t.text, t.created_at as createdAt, t.like_count as likeCount,
							e.source, e.raw_json as rawJson
						from tweets t
						join tweet_account_edges e on e.tweet_id = t.id
						where t.id = ? and e.account_id = ? and e.kind = 'home'`,
					)
					.get("fx-manual", "acct_fx_manual"),
			).toEqual({
				text: "authenticated bird text",
				createdAt: "2026-08-14T12:00:00.000Z",
				likeCount: 99,
				source: "bird",
				rawJson: expect.stringContaining("authenticated bird text"),
			});
			expect(
				home.db
					.prepare("select name, transport from accounts where id = ?")
					.get("acct_fx_manual"),
			).toEqual({ name: "Primary", transport: "bird" });
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
			await recordTwitter6551LocalHeartbeat(0, new Date(0));
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
