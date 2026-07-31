// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { useTestHome } from "../test/test-home";
import {
	ingestTwitter6551Tweets,
	normalizeTwitter6551Tweet,
	normalizeTwitter6551User,
	Twitter6551Client,
	getTwitter6551RuntimeStatus,
	recordTwitter6551LocalHeartbeat,
	stopTwitter6551WorkerManager,
	Twitter6551Worker,
	twitter6551TweetsToPayload,
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

	it("refuses custom hosts before a token can be transmitted", () => {
		expect(
			() =>
				new Twitter6551Client({
					token: "secret-token",
					baseUrl: "https://evil.example",
				}),
		).toThrow("protect the API token");
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
