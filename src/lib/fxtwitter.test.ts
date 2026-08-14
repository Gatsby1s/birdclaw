// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
	FXTWITTER_BASE_URL,
	FXTWITTER_MAX_RESPONSE_BYTES,
	FXTWITTER_REQUEST_TIMEOUT_MS,
	FXTWITTER_USER_AGENT,
	FxTwitterClient,
	FxTwitterError,
	fxTwitterTweetsToPayload,
	normalizeFxTwitterTweet,
	normalizeFxTwitterTweets,
	normalizeFxTwitterUser,
} from "./fxtwitter";

function jsonResponse(payload: unknown, status = 200, headers?: HeadersInit) {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

function apiUser(id = "42", screenName = "example") {
	return {
		type: "profile",
		id,
		name: screenName === "example" ? "Example User" : "Quoted User",
		screen_name: screenName,
		description: "bio",
		avatar_url: `https://pbs.twimg.com/${screenName}.jpg`,
		banner_url: `https://pbs.twimg.com/${screenName}-banner.jpg`,
		followers: 123,
		following: 45,
		statuses: 678,
		media_count: 9,
		likes: 321,
		verification: { verified: true, type: "individual" },
	};
}

function quotedStatus() {
	return {
		type: "status",
		id: "99",
		url: "https://x.com/quoted/status/99",
		text: "quoted text",
		created_at: "2026-08-14T09:00:00Z",
		likes: 2,
		reposts: 3,
		quotes: 4,
		replies: 5,
		author: apiUser("43", "quoted"),
		media: {
			photos: [
				{
					type: "photo",
					url: "https://pbs.twimg.com/quoted.jpg",
					width: 800,
					height: 600,
				},
			],
		},
		raw_text: { text: "quoted text", display_text_range: [0, 11], facets: [] },
	};
}

function focalStatus() {
	return {
		type: "status",
		id: "100",
		url: "https://x.com/example/status/100",
		text: "hello @quoted #BirdClaw https://example.com/a",
		created_at: "2026-08-14T10:00:00Z",
		likes: 7,
		reposts: 6,
		quotes: 5,
		replies: 4,
		views: 300,
		bookmarks: 8,
		lang: "en",
		conversation_id: "90",
		replying_to: {
			screen_name: "parent",
			status: "90",
			url: "https://x.com/parent/status/90",
			profile_url: "https://x.com/parent",
			display_name: "Parent User",
		},
		quote: quotedStatus(),
		author: apiUser(),
		media: {
			all: [
				{
					type: "video",
					url: "https://video.twimg.com/main.mp4",
					thumbnail_url: "https://pbs.twimg.com/main-thumb.jpg",
					width: 1280,
					height: 720,
					duration: 12,
					formats: [
						{
							url: "https://video.twimg.com/main-720.mp4",
							container: "mp4",
							bitrate: 2_000_000,
						},
					],
				},
			],
			photos: [
				{
					type: "photo",
					url: "https://pbs.twimg.com/duplicate-fallback.jpg",
				},
			],
		},
		raw_text: {
			text: "hello @quoted #BirdClaw https://t.co/a",
			display_text_range: [0, 42],
			facets: [
				{
					type: "mention",
					indices: [6, 13],
					original: "@quoted",
					display: "@quoted",
					id: "43",
				},
				{
					type: "hashtag",
					indices: [14, 23],
					original: "#BirdClaw",
				},
				{
					type: "url",
					indices: [24, 38],
					original: "https://t.co/a",
					replacement: "https://example.com/a",
					display: "example.com/a",
				},
				{ type: "bold", indices: [0, 5] },
			],
		},
	};
}

describe("FxTwitter v2 client", () => {
	it("uses the fixed host, GET, explicit user agent, and all four v2 routes", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () =>
			jsonResponse({
				code: 200,
				status: null,
				thread: [],
				replies: [],
				results: [],
				cursor: null,
			}),
		);
		const client = new FxTwitterClient({ fetchImpl, maxRetries: 0 });

		await client.getStatus("100", { aboutAccount: true, lang: "zh-cn" });
		await client.getProfileStatuses("name/with space", {
			count: 50,
			cursor: "next cursor",
			since: 1_754_006_400,
			withReplies: true,
			groupThreads: false,
			lang: "en",
		});
		await client.getConversation("100", {
			rankingMode: "recency",
			cursor: "bottom",
			aboutAccount: false,
			lang: "ja",
		});
		await client.getQuotes("100", { count: 25, cursor: "quotes", lang: "de" });

		const calls = fetchImpl.mock.calls.map(([input, init]) => ({
			url: String(input),
			method: init?.method,
			headers: new Headers(init?.headers),
		}));
		expect(calls.map((call) => call.url)).toEqual([
			`${FXTWITTER_BASE_URL}/2/status/100?about_account=true&lang=zh-cn`,
			`${FXTWITTER_BASE_URL}/2/profile/name%2Fwith%20space/statuses?count=50&cursor=next+cursor&since=1754006400&with_replies=true&groupthreads=false&lang=en`,
			`${FXTWITTER_BASE_URL}/2/conversation/100?ranking_mode=recency&cursor=bottom&about_account=false&lang=ja`,
			`${FXTWITTER_BASE_URL}/2/status/100/quotes?count=25&cursor=quotes&lang=de`,
		]);
		for (const call of calls) {
			expect(call.method).toBe("GET");
			expect(call.headers.get("user-agent")).toBe(FXTWITTER_USER_AGENT);
			expect(call.headers.get("accept")).toBe("application/json");
			expect(call.headers.has("authorization")).toBe(false);
		}
	});

	it("serializes profile since watermarks in seconds, milliseconds, and zero", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () =>
			jsonResponse({
				code: 200,
				results: [],
				cursor: { top: null, bottom: null },
			}),
		);
		const client = new FxTwitterClient({ fetchImpl, maxRetries: 0 });

		await client.getProfileStatuses("example", { since: 1_754_006_400 });
		await client.getProfileStatuses("example", { since: 1_754_006_400_000 });
		await client.getProfileStatuses("example", { since: 0 });

		expect(fetchImpl.mock.calls.map(([input]) => String(input))).toEqual([
			`${FXTWITTER_BASE_URL}/2/profile/example/statuses?since=1754006400`,
			`${FXTWITTER_BASE_URL}/2/profile/example/statuses?since=1754006400000`,
			`${FXTWITTER_BASE_URL}/2/profile/example/statuses?since=0`,
		]);
	});

	it("treats a business code error inside HTTP 200 as failure without retrying 4xx", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({ code: 404, message: "Post not found" }),
		);
		const client = new FxTwitterClient({
			fetchImpl,
			maxRetries: 2,
			sleep: vi.fn(),
		});

		await expect(client.getStatus("missing")).rejects.toMatchObject({
			name: "FxTwitterError",
			message: "Post not found",
			status: 200,
			code: 404,
			retryable: false,
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("retries only a finite number of retryable response codes", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse({ code: 429, message: "slow down" }))
			.mockResolvedValueOnce(
				jsonResponse({ code: 503, message: "upstream" }, 503),
			)
			.mockResolvedValueOnce(
				jsonResponse({
					code: 200,
					results: [],
					cursor: { top: null, bottom: null },
				}),
			);
		const sleep = vi.fn(async () => undefined);
		const client = new FxTwitterClient({ fetchImpl, maxRetries: 2, sleep });

		await expect(client.getQuotes("100")).resolves.toMatchObject({ code: 200 });
		expect(fetchImpl).toHaveBeenCalledTimes(3);
		expect(sleep).toHaveBeenNthCalledWith(1, 500);
		expect(sleep).toHaveBeenNthCalledWith(2, 1_000);
	});

	it("retries an HTTP 429 even when its body does not contain a code", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
			.mockResolvedValueOnce(
				jsonResponse({
					code: "200",
					results: [],
					cursor: { top: null, bottom: null },
				}),
			);
		const sleep = vi.fn(async () => undefined);
		const client = new FxTwitterClient({ fetchImpl, maxRetries: 1, sleep });

		await expect(client.getQuotes("100")).resolves.toMatchObject({ code: 200 });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledOnce();
	});

	it("honors Retry-After and stops after the configured retry budget", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({ code: 429, message: "slow down" }, 429, {
				"retry-after": "2",
			}),
		);
		const sleep = vi.fn(async () => undefined);
		const client = new FxTwitterClient({ fetchImpl, maxRetries: 1, sleep });

		await expect(client.getQuotes("100")).rejects.toBeInstanceOf(
			FxTwitterError,
		);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledOnce();
		expect(sleep).toHaveBeenCalledWith(2_000);
	});

	it("maps the documented profile-timeline 204 response to an empty page", async () => {
		const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
		const client = new FxTwitterClient({ fetchImpl, maxRetries: 0 });

		await expect(client.getProfileStatuses("empty")).resolves.toEqual({
			code: 204,
			results: [],
			cursor: null,
		});
	});

	it("rejects malformed success envelopes without a numeric code", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({ status: null, thread: [] }),
		);
		const client = new FxTwitterClient({ fetchImpl, maxRetries: 0 });

		await expect(client.getStatus("100")).rejects.toThrow(
			"missing a numeric code field",
		);
	});

	it("rejects endpoint-specific success envelopes with missing or malformed fields", async () => {
		const responses = [
			jsonResponse({ code: 200, cursor: null }),
			jsonResponse({ code: 200, status: {}, thread: "not-an-array" }),
			jsonResponse({
				code: 200,
				status: null,
				thread: [],
				replies: [],
				cursor: { bottom: 42 },
			}),
		];
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockImplementation(async () => responses.shift()!);
		const client = new FxTwitterClient({ fetchImpl, maxRetries: 0 });

		await expect(client.getProfileStatuses("example")).rejects.toThrow(
			"invalid results field",
		);
		await expect(client.getStatus("100")).rejects.toThrow(
			"invalid thread field",
		);
		await expect(client.getConversation("100")).rejects.toThrow(
			"invalid cursor.bottom field",
		);
	});

	it("caps response bodies by declared and actual streamed byte length", async () => {
		const declaredCancel = vi.fn();
		const declaredTooLarge = vi.fn(
			async () =>
				new Response(new ReadableStream({ cancel: declaredCancel }), {
					headers: {
						"content-length": String(FXTWITTER_MAX_RESPONSE_BYTES + 1),
					},
				}),
		);
		await expect(
			new FxTwitterClient({
				fetchImpl: declaredTooLarge,
				maxRetries: 0,
			}).getStatus("100"),
		).rejects.toThrow(
			`response exceeds ${String(FXTWITTER_MAX_RESPONSE_BYTES)} bytes`,
		);
		expect(declaredCancel).toHaveBeenCalledOnce();

		const streamedCancel = vi.fn(() => {
			throw new Error("cancel failed");
		});
		const streamedTooLarge = vi.fn(
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new Uint8Array([1, 2, 3, 4, 5]));
						},
						cancel: streamedCancel,
					}),
				),
		);
		await expect(
			new FxTwitterClient({
				fetchImpl: streamedTooLarge,
				maxRetries: 0,
				maxResponseBytes: 4,
			}).getStatus("100"),
		).rejects.toThrow("response exceeds 4 bytes");
		expect(streamedCancel).toHaveBeenCalledOnce();
	});

	it("uses a 30 second default timeout", async () => {
		vi.useFakeTimers();
		try {
			const fetchImpl = vi.fn(
				(_input: RequestInfo | URL, init?: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => {
							reject(new DOMException("aborted", "AbortError"));
						});
					}),
			);
			const client = new FxTwitterClient({ fetchImpl, maxRetries: 0 });
			const result = client.getStatus("100").catch((error: unknown) => error);

			await vi.advanceTimersByTimeAsync(FXTWITTER_REQUEST_TIMEOUT_MS);
			expect(await result).toMatchObject({
				message: `FxTwitter request timed out after ${String(FXTWITTER_REQUEST_TIMEOUT_MS)}ms`,
			});
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("FxTwitter normalizer and ingest adapter", () => {
	it("preserves media, nested quote, reply context, tweet metrics, and user metrics", () => {
		const tweet = normalizeFxTwitterTweet(focalStatus());

		expect(tweet).toMatchObject({
			id: "100",
			text: "hello @quoted #BirdClaw https://t.co/a",
			createdAt: "2026-08-14T10:00:00.000Z",
			lang: "en",
			conversationId: "90",
			user: {
				id: "42",
				screenName: "example",
				verified: true,
				metrics: {
					followers: 123,
					following: 45,
					statuses: 678,
					media: 9,
					likes: 321,
				},
			},
			metrics: {
				likes: 7,
				reposts: 6,
				quotes: 5,
				replies: 4,
				views: 300,
				bookmarks: 8,
			},
			reply: {
				id: "90",
				screenName: "parent",
				displayName: "Parent User",
			},
			quote: {
				kind: "tweet",
				id: "99",
				text: "quoted text",
				user: { id: "43", screenName: "quoted" },
			},
			media: [
				{
					type: "video",
					url: "https://video.twimg.com/main.mp4",
					thumbnailUrl: "https://pbs.twimg.com/main-thumb.jpg",
					width: 1280,
					height: 720,
					durationSeconds: 12,
					variants: [
						{
							url: "https://video.twimg.com/main-720.mp4",
							contentType: "video/mp4",
							bitRate: 2_000_000,
						},
					],
				},
			],
		});
		expect(tweet?.facets).toHaveLength(3);
	});

	it("preserves quote tombstones and accepts timestamp fallback", () => {
		const source = {
			...focalStatus(),
			created_at: undefined,
			created_timestamp: 1_765_722_600,
			quote: {
				type: "tombstone",
				id: "98",
				provider: "twitter",
				reason: "deleted",
				message: "Post was deleted",
				url: "https://x.com/i/status/98",
			},
		};

		expect(normalizeFxTwitterTweet(source)).toMatchObject({
			createdAt: "2025-12-14T14:30:00.000Z",
			quote: {
				kind: "tombstone",
				id: "98",
				reason: "deleted",
				message: "Post was deleted",
			},
		});
	});

	it("rejects malformed identities and filters invalid list entries", () => {
		expect(normalizeFxTwitterUser(null)).toBeNull();
		expect(normalizeFxTwitterUser({ id: "42" })).toBeNull();
		expect(
			normalizeFxTwitterTweet({ ...focalStatus(), author: { name: "no id" } }),
		).toBeNull();
		expect(
			normalizeFxTwitterTweets([null, { type: "tombstone" }, focalStatus()]),
		).toHaveLength(1);
	});

	it("drops native reposts that lack a wrapper id and repost timestamp", () => {
		const repost = {
			...focalStatus(),
			reposted_by: {
				id: "1879650942410481666",
				name: "Reposter",
				screen_name: "reposter",
				avatar_url: "https://pbs.twimg.com/reposter.jpg",
				url: "https://x.com/reposter",
			},
		};

		expect(normalizeFxTwitterTweet(repost)).toBeNull();
		expect(normalizeFxTwitterTweets([focalStatus(), repost])).toHaveLength(1);
	});

	it("expands grouped profile timeline threads without dropping their statuses", () => {
		const second = {
			...focalStatus(),
			id: "101",
			quote: undefined,
			conversation_id: undefined,
			replying_to: { screen_name: "example", status: "100" },
		};
		const tweets = normalizeFxTwitterTweets([
			{
				type: "thread",
				conversation_id: "100",
				statuses: [focalStatus(), second],
				all_status_ids: ["100", "101"],
				truncated: false,
			},
		]);

		expect(tweets).toHaveLength(2);
		expect(tweets.map((tweet) => tweet.id)).toEqual(["100", "101"]);
		expect(tweets.map((tweet) => tweet.conversationId)).toEqual(["90", "100"]);
	});

	it("produces an ingest-ready XURL payload including quoted tweet context", () => {
		const tweet = normalizeFxTwitterTweet(focalStatus());
		expect(tweet).not.toBeNull();

		const payload = fxTwitterTweetsToPayload([tweet!]);
		expect(payload.meta).toEqual({ result_count: 1, source: "fxtwitter" });
		expect(payload.data[0]).toMatchObject({
			id: "100",
			author_id: "42",
			text: "hello @quoted #BirdClaw https://t.co/a",
			conversation_id: "90",
			referenced_tweets: [
				{ type: "replied_to", id: "90" },
				{ type: "quoted", id: "99" },
			],
			attachments: { media_keys: ["100:0"] },
			public_metrics: {
				like_count: 7,
				retweet_count: 6,
				reply_count: 4,
				quote_count: 5,
				bookmark_count: 8,
				impression_count: 300,
			},
		});
		expect(payload.data[0].entities).toMatchObject({
			mentions: [{ username: "quoted", id: "43", start: 6, end: 13 }],
			hashtags: [{ tag: "BirdClaw", start: 14, end: 23 }],
			urls: [
				{
					url: "https://t.co/a",
					expanded_url: "https://example.com/a",
					display_url: "example.com/a",
					start: 24,
					end: 38,
				},
			],
		});
		expect(payload.includes?.tweets).toEqual([
			expect.objectContaining({
				id: "99",
				author_id: "43",
				text: "quoted text",
			}),
		]);
		expect(payload.includes?.users).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "42",
					public_metrics: {
						followers_count: 123,
						following_count: 45,
						tweet_count: 678,
					},
				}),
				expect.objectContaining({ id: "43" }),
			]),
		);
		expect(payload.includes?.media).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					media_key: "100:0",
					type: "video",
					preview_image_url: "https://pbs.twimg.com/main-thumb.jpg",
					duration_ms: 12_000,
				}),
				expect.objectContaining({ media_key: "99:0", type: "photo" }),
			]),
		);
	});
});
