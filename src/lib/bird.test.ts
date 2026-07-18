// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

const execFileAsyncMock = vi.fn();

vi.mock("node:child_process", () => ({
	execFile: Object.assign(vi.fn(), {
		[Symbol.for("nodejs.util.promisify.custom")]: execFileAsyncMock,
	}),
}));

function mockBirdStdoutOnce(stdout: string) {
	execFileAsyncMock.mockImplementationOnce(async (_command, args: string[]) => {
		writeFileSync(args[3] ?? "", stdout);
		return { stdout: "", stderr: "" };
	});
}

function mockBirdRejectOnce(error: Error & { stderr?: string }) {
	execFileAsyncMock.mockImplementationOnce(async () => {
		throw error;
	});
}

function mockBirdRejectWithStdoutOnce(
	stdout: string,
	error: Error & { stderr?: string },
) {
	execFileAsyncMock.mockImplementationOnce(async (_command, args: string[]) => {
		writeFileSync(args[3] ?? "", stdout);
		throw error;
	});
}

function expectBirdCommandCall(callNumber: number, args: string[]) {
	const call = execFileAsyncMock.mock.calls[callNumber - 1];
	expect(call).toBeDefined();
	expect(call[0]).toBe("/bin/bash");
	expect((call[1] as string[])[0]).toBe("-c");
	expect((call[1] as string[]).slice(4)).toEqual(["/tmp/bird", ...args]);
	expect(call[2]).toEqual(
		expect.objectContaining({ maxBuffer: expect.any(Number) }),
	);
}

describe("bird transport wrapper", () => {
	afterEach(() => {
		vi.resetModules();
		execFileAsyncMock.mockReset();
		delete process.env.BIRDCLAW_BIRD_COMMAND;
		delete process.env.BIRDCLAW_CONFIG;
	});

	it("keeps config parse failures behind the Effect promise boundary", async () => {
		const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-bird-"));
		const configPath = path.join(tempDir, "config.json");
		writeFileSync(configPath, "{bad json", "utf8");
		process.env.BIRDCLAW_CONFIG = configPath;

		const { runBirdJsonCommandEffect } = await import("./bird");
		const { runEffectPromise } = await import("./effect-runtime");
		let promise: Promise<unknown> | undefined;

		expect(() => {
			promise = runEffectPromise(runBirdJsonCommandEffect(["mentions"]));
		}).not.toThrow();
		await expect(promise).rejects.toThrow(/JSON/);
		expect(execFileAsyncMock).not.toHaveBeenCalled();

		rmSync(tempDir, { recursive: true, force: true });
	});

	it("maps bird mentions json into xurl-compatible payloads", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		mockBirdStdoutOnce(
			JSON.stringify([
				{
					id: "tweet_1",
					text: "hello from bird",
					createdAt: "Fri Mar 13 02:01:58 +0000 2026",
					replyCount: 1,
					retweetCount: 2,
					likeCount: 3,
					conversationId: "tweet_root_1",
					inReplyToStatusId: "tweet_parent_1",
					authorId: "42",
					author: {
						username: "sam",
						name: "Sam",
					},
					media: [
						{
							type: "photo",
							url: "https://pbs.twimg.com/media/demo.jpg",
						},
					],
				},
			]),
		);
		const { listMentionsViaBird } = await import("./bird");

		const payload = await listMentionsViaBird({
			maxResults: 12,
		});

		expectBirdCommandCall(1, ["mentions", "-n", "12", "--json"]);
		expect(payload).toEqual({
			data: [
				expect.objectContaining({
					id: "tweet_1",
					author_id: "42",
					text: "hello from bird",
					conversation_id: "tweet_root_1",
					referenced_tweets: [{ type: "replied_to", id: "tweet_parent_1" }],
					public_metrics: expect.objectContaining({
						reply_count: 1,
						retweet_count: 2,
						like_count: 3,
					}),
					entities: expect.objectContaining({
						urls: [
							expect.objectContaining({
								url: "https://pbs.twimg.com/media/demo.jpg",
								media_key: "bird_media_0",
							}),
						],
					}),
				}),
			],
			includes: {
				users: [
					{
						id: "42",
						username: "sam",
						name: "Sam",
					},
				],
			},
			meta: expect.objectContaining({
				result_count: 1,
				page_count: 1,
				next_token: null,
			}),
		});
	});

	it("keeps bird collection adapters lazy as Effect programs", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		mockBirdStdoutOnce(
			JSON.stringify([
				{
					id: "tweet_effect_1",
					text: "lazy bird",
					createdAt: "2026-05-01T00:00:00.000Z",
					authorId: "42",
					author: { username: "sam", name: "Sam" },
				},
			]),
		);
		const { listMentionsViaBirdEffect } = await import("./bird");

		const effect = listMentionsViaBirdEffect({ maxResults: 3 });

		expect(execFileAsyncMock).not.toHaveBeenCalled();
		await expect(Effect.runPromise(effect)).resolves.toEqual(
			expect.objectContaining({
				data: [expect.objectContaining({ id: "tweet_effect_1" })],
			}),
		);
		expectBirdCommandCall(1, ["mentions", "-n", "3", "--json"]);
	});

	it("omits max-pages for single-page bird search", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		mockBirdStdoutOnce("[]");
		mockBirdStdoutOnce("[]");
		const { searchTweetsViaBird } = await import("./bird");

		await expect(
			searchTweetsViaBird("ChatGPT", { maxResults: 5, maxPages: 1 }),
		).resolves.toEqual({
			data: [],
			includes: undefined,
			meta: {
				result_count: 0,
				page_count: 1,
				next_token: null,
				newest_id: undefined,
				oldest_id: undefined,
			},
		});
		expectBirdCommandCall(1, ["search", "ChatGPT", "-n", "5", "--json"]);

		await searchTweetsViaBird("ChatGPT", {
			maxResults: 5,
			all: true,
			maxPages: 2,
		});
		expectBirdCommandCall(2, [
			"search",
			"ChatGPT",
			"-n",
			"5",
			"--json",
			"--all",
			"--max-pages",
			"2",
		]);
	});

	it("maps mention fallbacks and empty mention payloads", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		mockBirdStdoutOnce(
			JSON.stringify([
				{
					id: "tweet_2",
					text: "fallback author",
					createdAt: "not a date",
					media: [],
				},
				{
					id: "tweet_3",
					text: "username author",
					createdAt: "2026-01-02T03:04:05.000Z",
					author: { username: "max" },
					replyCount: "4",
					retweetCount: "5",
					likeCount: "6",
					media: [
						{ type: "photo", url: "" },
						{ type: "photo", url: "https://pbs.twimg.com/media/other.jpg" },
					],
				},
			]),
		);
		mockBirdStdoutOnce("[]");

		const { listMentionsViaBird } = await import("./bird");

		await expect(listMentionsViaBird({ maxResults: 2 })).resolves.toEqual({
			data: [
				expect.objectContaining({
					id: "tweet_2",
					author_id: "unknown",
					created_at: "not a date",
					conversation_id: "tweet_2",
					entities: undefined,
					public_metrics: {
						reply_count: 0,
						retweet_count: 0,
						like_count: 0,
					},
				}),
				expect.objectContaining({
					id: "tweet_3",
					author_id: "max",
					conversation_id: "tweet_3",
					entities: {
						urls: [
							{
								start: 0,
								end: 0,
								url: "https://pbs.twimg.com/media/other.jpg",
								expanded_url: "https://pbs.twimg.com/media/other.jpg",
								display_url: "https://pbs.twimg.com/media/other.jpg",
								media_key: "bird_media_0",
							},
						],
					},
					public_metrics: {
						reply_count: 4,
						retweet_count: 5,
						like_count: 6,
					},
				}),
			],
			includes: {
				users: [
					{ id: "unknown", username: "user_unknown", name: "user_unknown" },
					{ id: "max", username: "max", name: "max" },
				],
			},
			meta: {
				result_count: 2,
				page_count: 1,
				next_token: null,
				newest_id: "tweet_2",
				oldest_id: "tweet_3",
			},
		});

		await expect(listMentionsViaBird({ maxResults: 0 })).resolves.toEqual({
			data: [],
			includes: undefined,
			meta: {
				result_count: 0,
				page_count: 1,
				next_token: null,
			},
		});
	});

	it("rejects unexpected mention json", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		mockBirdStdoutOnce("{}");

		const { listMentionsViaBird } = await import("./bird");

		await expect(listMentionsViaBird({ maxResults: 10 })).rejects.toThrow(
			"bird mentions returned unexpected JSON",
		);
	});

	it("explains how to configure bird when the binary is missing", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/missing/bird";
		mockBirdRejectOnce(
			Object.assign(new Error("command failed"), {
				stderr:
					"birdclaw-bird: /missing/bird: No such file or directory\nbirdclaw-bird: line 0: exec: /missing/bird: cannot execute: No such file or directory",
			}),
		);

		const { listMentionsViaBird } = await import("./bird");

		await expect(listMentionsViaBird({ maxResults: 10 })).rejects.toThrow(
			"bird command unavailable: /missing/bird",
		);
	});

	it("tolerates bird json with raw newlines inside tweet text", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		mockBirdStdoutOnce(
			'[{ "id": "tweet_1", "text": "first line\nsecond line", "createdAt": "2026-04-26T13:43:34.000Z", "authorId": "42", "author": { "username": "sam", "name": "Sam" } }]',
		);
		const { listLikedTweetsViaBird } = await import("./bird");

		await expect(listLikedTweetsViaBird({ maxResults: 1 })).resolves.toEqual(
			expect.objectContaining({
				data: [
					expect.objectContaining({
						id: "tweet_1",
						text: "first line\nsecond line",
					}),
				],
			}),
		);
	});

	it("returns bird direct messages payloads", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		const payload = {
			success: true,
			conversations: [
				{
					id: "dm_1",
					participants: [{ id: "42", username: "sam", name: "Sam" }],
					messages: [{ id: "event_1", text: "hello" }],
				},
			],
			events: [{ id: "event_1", text: "hello" }],
		};
		mockBirdStdoutOnce(JSON.stringify(payload));

		const { listDirectMessagesViaBird } = await import("./bird");

		await expect(listDirectMessagesViaBird({ maxResults: 5 })).resolves.toEqual(
			payload,
		);
		expectBirdCommandCall(1, ["dms", "-n", "5", "--json"]);
	});

	it("parses the authenticated bird account from whoami output", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		mockBirdStdoutOnce(
			[
				"📍 Chrome default profile",
				"🙋 @steipete (Peter Steinberger 2026)",
				"🪪 25401953",
				"⚙️ graphql",
			].join("\n"),
		);

		const { getAuthenticatedBirdAccount } = await import("./bird");

		await expect(getAuthenticatedBirdAccount()).resolves.toEqual({
			id: "25401953",
			username: "steipete",
		});
		expectBirdCommandCall(1, ["whoami"]);
	});

	it("passes message-request DM paging options to bird", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		const payload = { success: true, conversations: [], events: [] };
		mockBirdStdoutOnce(JSON.stringify(payload));

		const { listDirectMessagesViaBird } = await import("./bird");

		await expect(
			listDirectMessagesViaBird({
				maxResults: 50,
				inbox: "requests",
				maxPages: 2,
				pageDelayMs: 750,
			}),
		).resolves.toEqual(payload);
		expectBirdCommandCall(1, [
			"dms",
			"-n",
			"50",
			"--json",
			"--inbox",
			"requests",
			"--max-pages",
			"2",
			"--page-delay-ms",
			"750",
		]);
	});

	it("preserves structured JSON from failed bird DM mutations", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		const payload = { success: false, error: "not found" };
		mockBirdRejectWithStdoutOnce(JSON.stringify(payload), new Error("exit 1"));

		const { runDirectMessageRequestMutationViaBird } = await import("./bird");

		await expect(
			runDirectMessageRequestMutationViaBird({
				action: "reject",
				conversationId: "111-333",
			}),
		).resolves.toEqual(payload);
		expectBirdCommandCall(1, ["dm-reject", "111-333", "--json"]);
	});

	it("passes pagination options to bird DM block mutations", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		const payload = {
			success: true,
			conversationId: "111-333",
			blockedUserId: "333",
		};
		mockBirdStdoutOnce(JSON.stringify(payload));

		const { runDirectMessageRequestMutationViaBird } = await import("./bird");

		await expect(
			runDirectMessageRequestMutationViaBird({
				action: "block",
				conversationId: "111-333",
				maxPages: 8,
			}),
		).resolves.toEqual(payload);
		expectBirdCommandCall(1, [
			"dm-block",
			"111-333",
			"--json",
			"--max-pages",
			"8",
		]);
	});

	it("maps bird likes and bookmarks json into xurl-compatible payloads", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		mockBirdStdoutOnce(
			JSON.stringify([
				{
					id: "liked_1",
					text: "liked from bird",
					createdAt: "2026-04-26T13:43:34.000Z",
					authorId: "42",
					author: { username: "sam", name: "Sam" },
				},
			]),
		);
		mockBirdStdoutOnce(
			JSON.stringify([
				{
					id: "bookmark_1",
					text: "saved from bird",
					createdAt: "2026-04-26T13:43:34.000Z",
					authorId: "43",
					author: { username: "amelia", name: "Amelia" },
				},
			]),
		);
		const { listBookmarkedTweetsViaBird, listLikedTweetsViaBird } =
			await import("./bird");

		await expect(listLikedTweetsViaBird({ maxResults: 5 })).resolves.toEqual({
			data: [expect.objectContaining({ id: "liked_1", author_id: "42" })],
			includes: { users: [{ id: "42", username: "sam", name: "Sam" }] },
			meta: expect.objectContaining({ result_count: 1 }),
		});
		await expect(
			listBookmarkedTweetsViaBird({
				maxResults: 7,
				all: true,
				maxPages: 2,
			}),
		).resolves.toEqual({
			data: [expect.objectContaining({ id: "bookmark_1", author_id: "43" })],
			includes: { users: [{ id: "43", username: "amelia", name: "Amelia" }] },
			meta: expect.objectContaining({ result_count: 1 }),
		});
		expectBirdCommandCall(1, ["likes", "-n", "5", "--json"]);
		expectBirdCommandCall(2, [
			"bookmarks",
			"-n",
			"7",
			"--json",
			"--all",
			"--max-pages",
			"2",
		]);
	});

	it("maps bird home timeline json into xurl-compatible payloads", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		mockBirdStdoutOnce(
			JSON.stringify([
				{
					id: "home_1",
					text: "home from bird",
					createdAt: "Mon May 04 07:19:34 +0000 2026",
					authorId: "45",
					author: { username: "riley", name: "Riley" },
				},
			]),
		);
		mockBirdStdoutOnce(
			JSON.stringify({
				users: [
					{
						id: "45",
						username: "riley",
						name: "Riley",
						profileImageUrl:
							"https://pbs.twimg.com/profile_images/45/riley_normal.jpg",
						followersCount: 123,
						followingCount: 17,
					},
				],
			}),
		);
		const { listHomeTimelineViaBird } = await import("./bird");

		await expect(
			listHomeTimelineViaBird({ maxResults: 9, following: true }),
		).resolves.toEqual({
			data: [expect.objectContaining({ id: "home_1", author_id: "45" })],
			includes: {
				users: [
					expect.objectContaining({
						id: "45",
						username: "riley",
						name: "Riley",
						profile_image_url:
							"https://pbs.twimg.com/profile_images/45/riley_normal.jpg",
						public_metrics: {
							followers_count: 123,
							following_count: 17,
						},
					}),
				],
			},
			meta: expect.objectContaining({ result_count: 1 }),
		});
		expectBirdCommandCall(1, ["home", "-n", "9", "--json", "--following"]);
		expectBirdCommandCall(2, ["profiles", "riley", "--json"]);
	});

	it("keeps nested bird quoted and retweeted tweets as included tweets", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		mockBirdStdoutOnce(
			JSON.stringify([
				{
					id: "home_quote",
					text: "quoting from bird",
					createdAt: "Mon May 04 07:19:34 +0000 2026",
					authorId: "45",
					author: { username: "riley", name: "Riley" },
					quotedTweet: {
						id: "quote_source",
						text: "nested quote text",
						createdAt: "Mon May 04 07:17:34 +0000 2026",
						authorId: "46",
						author: { username: "lee", name: "Lee" },
						likeCount: 8,
					},
				},
				{
					id: "home_retweet",
					text: "RT @lee: nested retweet text",
					createdAt: "Mon May 04 07:18:34 +0000 2026",
					authorId: "45",
					author: { username: "riley", name: "Riley" },
					retweetedTweet: {
						id: "retweet_source",
						text: "nested retweet text",
						createdAt: "Mon May 04 07:16:34 +0000 2026",
						authorId: "46",
						author: { username: "lee", name: "Lee" },
						likeCount: 9,
					},
				},
			]),
		);
		const { listHomeTimelineViaBird } = await import("./bird");

		await expect(
			listHomeTimelineViaBird({ maxResults: 9, following: true }),
		).resolves.toEqual({
			data: [
				expect.objectContaining({
					id: "home_quote",
					referenced_tweets: [{ type: "quoted", id: "quote_source" }],
				}),
				expect.objectContaining({
					id: "home_retweet",
					referenced_tweets: [{ type: "retweeted", id: "retweet_source" }],
				}),
			],
			includes: {
				users: [
					{ id: "45", username: "riley", name: "Riley" },
					{ id: "46", username: "lee", name: "Lee" },
				],
				tweets: [
					expect.objectContaining({
						id: "quote_source",
						author_id: "46",
						text: "nested quote text",
					}),
					expect.objectContaining({
						id: "retweet_source",
						author_id: "46",
						text: "nested retweet text",
					}),
				],
			},
			meta: expect.objectContaining({ result_count: 2 }),
		});
		expectBirdCommandCall(1, ["home", "-n", "9", "--json", "--following"]);
	});

	it("hydrates retweeted author avatars from bird raw user results", async () => {
		const { __test__ } = await import("./bird");
		const payload = __test__.normalizeBirdTweets([
			{
				id: "home_retweet",
				text: "RT @enzo_gte: I've been using Kimi K3",
				createdAt: "Sat Jul 18 09:29:03 +0000 2026",
				authorId: "1577241403",
				author: {
					username: "levelsio",
					name: "@levelsio",
					profileImageUrl:
						"https://pbs.twimg.com/profile_images/levelsio_normal.jpg",
				},
				retweetedTweet: {
					id: "2078102070482153717",
					text: "I've been using Kimi K3 for ~16 hours now.",
					createdAt: "Fri Jul 17 12:58:37 +0000 2026",
					authorId: "1207822149248962561",
					author: { username: "enzo_gte", name: "enzo" },
					_raw: {
						core: {
							user_results: {
								result: {
									__typename: "User",
									rest_id: "1207822149248962561",
									avatar: {
										image_url:
											"https://pbs.twimg.com/profile_images/1991573446875058176/y3pmE469_normal.jpg",
									},
									core: {
										screen_name: "enzo_gte",
										name: "enzo",
										created_at: "Thu Dec 19 20:28:02 +0000 2019",
									},
									legacy: {
										description: "founder @gte_xyz",
										followers_count: 13260,
										friends_count: 692,
									},
								},
							},
						},
					},
				},
			},
		]);

		expect(payload.includes?.tweets?.[0]).toMatchObject({
			id: "2078102070482153717",
			author_id: "1207822149248962561",
		});
		expect(payload.includes?.users).toEqual([
			expect.objectContaining({
				id: "1577241403",
				username: "levelsio",
				profile_image_url:
					"https://pbs.twimg.com/profile_images/levelsio_normal.jpg",
			}),
			expect.objectContaining({
				id: "1207822149248962561",
				username: "enzo_gte",
				name: "enzo",
				description: "founder @gte_xyz",
				profile_image_url:
					"https://pbs.twimg.com/profile_images/1991573446875058176/y3pmE469_normal.jpg",
				public_metrics: {
					followers_count: 13260,
					following_count: 692,
				},
			}),
		]);
	});

	it("maps bird follower lists into xurl-compatible users", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		mockBirdStdoutOnce(
			JSON.stringify({
				users: [
					{
						id: "42",
						username: "sam",
						name: "Sam",
						description: "Working on systems",
						followersCount: 123,
						followingCount: 45,
						profileImageUrl:
							"https://pbs.twimg.com/profile_images/42/avatar_normal.jpg",
						createdAt: "Mon Jan 01 00:00:00 +0000 2024",
					},
				],
				nextCursor: "cursor-two",
			}),
		);
		mockBirdStdoutOnce(
			JSON.stringify([
				{
					id: "43",
					username: "amelia",
					name: "Amelia",
					followersCount: 7,
				},
			]),
		);
		const { listFollowUsersViaBird } = await import("./bird");

		await expect(
			listFollowUsersViaBird({
				direction: "followers",
				userId: "25401953",
				maxResults: 100,
				all: true,
				maxPages: 2,
			}),
		).resolves.toEqual({
			data: [
				expect.objectContaining({
					id: "42",
					username: "sam",
					public_metrics: {
						followers_count: 123,
						following_count: 45,
					},
				}),
			],
			meta: {
				result_count: 1,
				page_count: 1,
				next_token: "cursor-two",
			},
		});
		await expect(
			listFollowUsersViaBird({
				direction: "following",
				maxResults: 10,
			}),
		).resolves.toEqual({
			data: [
				expect.objectContaining({
					id: "43",
					username: "amelia",
					public_metrics: {
						followers_count: 7,
						following_count: 0,
					},
				}),
			],
			meta: {
				result_count: 1,
				page_count: 1,
				next_token: null,
			},
		});
		expectBirdCommandCall(1, [
			"followers",
			"-n",
			"100",
			"--json",
			"--user",
			"25401953",
			"--all",
			"--max-pages",
			"2",
		]);
		expectBirdCommandCall(2, ["following", "-n", "10", "--json"]);
	});

	it("maps bird thread json with reply references", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		mockBirdStdoutOnce(
			JSON.stringify([
				{
					id: "reply_1",
					text: "thread reply",
					createdAt: "2026-05-04T07:19:34.000Z",
					conversationId: "root_1",
					inReplyToStatusId: "root_1",
					authorId: "46",
					author: { username: "casey", name: "Casey" },
				},
			]),
		);
		const { listThreadViaBird } = await import("./bird");

		await expect(
			listThreadViaBird({ tweetId: "reply_1", maxPages: 2, timeoutMs: 5000 }),
		).resolves.toEqual({
			data: [
				expect.objectContaining({
					id: "reply_1",
					author_id: "46",
					conversation_id: "root_1",
					referenced_tweets: [{ type: "replied_to", id: "root_1" }],
				}),
			],
			includes: { users: [{ id: "46", username: "casey", name: "Casey" }] },
			meta: expect.objectContaining({ result_count: 1 }),
		});
		expectBirdCommandCall(1, [
			"thread",
			"reply_1",
			"--json",
			"--max-pages",
			"2",
		]);
		expect(execFileAsyncMock.mock.calls[0]?.[2]).toEqual(
			expect.objectContaining({ timeout: 5000 }),
		);
	});

	it("accepts current bird collection objects", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		mockBirdStdoutOnce(
			JSON.stringify({
				tweets: [
					{
						id: "bookmark_2",
						text: "saved object shape",
						createdAt: "2026-04-26T13:43:34.000Z",
						authorId: "44",
						author: { username: "jules", name: "Jules" },
					},
				],
				nextCursor: null,
			}),
		);
		const { listBookmarkedTweetsViaBird } = await import("./bird");

		await expect(
			listBookmarkedTweetsViaBird({ maxResults: 5, all: true }),
		).resolves.toEqual({
			data: [expect.objectContaining({ id: "bookmark_2", author_id: "44" })],
			includes: { users: [{ id: "44", username: "jules", name: "Jules" }] },
			meta: expect.objectContaining({ result_count: 1 }),
		});
	});

	it("looks up tweets by id through bird read", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		mockBirdStdoutOnce(
			JSON.stringify({
				id: "tweet_1",
				text: "read from bird",
				createdAt: "Tue May 05 15:07:12 +0000 2026",
				authorId: "42",
				author: { username: "sam", name: "Sam" },
				conversationId: "tweet_root",
				inReplyToStatusId: "tweet_root",
				quotedTweet: { id: "tweet_quote" },
				likeCount: 9,
			}),
		);
		const { lookupTweetsByIdsViaBird } = await import("./bird");

		await expect(lookupTweetsByIdsViaBird(["tweet_1"])).resolves.toEqual({
			data: [
				expect.objectContaining({
					id: "tweet_1",
					author_id: "42",
					text: "read from bird",
					conversation_id: "tweet_root",
					referenced_tweets: [
						{ type: "replied_to", id: "tweet_root" },
						{ type: "quoted", id: "tweet_quote" },
					],
				}),
			],
			includes: { users: [{ id: "42", username: "sam", name: "Sam" }] },
			meta: expect.objectContaining({ result_count: 1 }),
		});
		expectBirdCommandCall(1, ["read", "tweet_1", "--json"]);
	});

	it("looks up profiles through bird user json", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		mockBirdStdoutOnce(
			JSON.stringify({
				user: {
					id: "42",
					username: "sam",
					name: "Sam",
					description: "Working on systems",
					followersCount: 123,
					followingCount: 45,
					profileImageUrl:
						"https://pbs.twimg.com/profile_images/42/avatar_normal.jpg",
					createdAt: "Mon Jan 01 00:00:00 +0000 2024",
				},
			}),
		);
		const { lookupProfileViaBird } = await import("./bird");

		await expect(lookupProfileViaBird("42")).resolves.toEqual({
			id: "42",
			username: "sam",
			name: "Sam",
			description: "Working on systems",
			profile_image_url:
				"https://pbs.twimg.com/profile_images/42/avatar_normal.jpg",
			created_at: "Mon Jan 01 00:00:00 +0000 2024",
			public_metrics: {
				followers_count: 123,
				following_count: 45,
			},
		});
		expectBirdCommandCall(1, ["user", "42", "--json", "--profile-only"]);
	});

	it("falls back to count one for older bird profile lookups", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		mockBirdRejectOnce(
			Object.assign(new Error("Command failed"), {
				stderr: "error: unknown option '--profile-only'",
			}),
		);
		mockBirdStdoutOnce(
			JSON.stringify({
				user: {
					id: "42",
					username: "sam",
					name: "Sam",
					followersCount: 123,
				},
			}),
		);
		const { lookupProfileViaBird } = await import("./bird");

		await expect(lookupProfileViaBird("42")).resolves.toEqual(
			expect.objectContaining({
				id: "42",
				username: "sam",
				public_metrics: expect.objectContaining({ followers_count: 123 }),
			}),
		);
		expectBirdCommandCall(1, ["user", "42", "--json", "--profile-only"]);
		expectBirdCommandCall(2, ["user", "42", "--json", "--count", "1"]);
	});

	it("falls back to the bird following list when bird user is unavailable", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		mockBirdRejectOnce(
			Object.assign(new Error("unknown command user"), {
				stderr: "error: unknown command user",
			}),
		);
		mockBirdStdoutOnce(
			JSON.stringify([
				{
					id: "42",
					username: "sam",
					name: "Sam",
					profileImageUrl:
						"https://pbs.twimg.com/profile_images/42/avatar_normal.jpg",
				},
			]),
		);
		const { lookupProfileViaBird } = await import("./bird");

		await expect(lookupProfileViaBird("sam")).resolves.toEqual(
			expect.objectContaining({
				id: "42",
				username: "sam",
				profile_image_url:
					"https://pbs.twimg.com/profile_images/42/avatar_normal.jpg",
			}),
		);
		expectBirdCommandCall(1, ["user", "sam", "--json", "--profile-only"]);
		expectBirdCommandCall(2, ["following", "-n", "1000", "--json"]);
	});

	it("falls back to bird user-tweets when the following lookup fails", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		mockBirdRejectOnce(
			Object.assign(new Error("unknown command user"), {
				stderr: "error: unknown command user",
			}),
		);
		mockBirdRejectOnce(
			Object.assign(new Error("following lookup failed"), {
				stderr: "error: following lookup failed",
			}),
		);
		mockBirdStdoutOnce(
			JSON.stringify([
				{
					id: "2078102070482153717",
					text: "I've been using Kimi K3 for ~16 hours now.",
					createdAt: "Fri Jul 17 12:58:37 +0000 2026",
					authorId: "1207822149248962561",
					author: { username: "enzo_gte", name: "enzo" },
					_raw: {
						core: {
							user_results: {
								result: {
									rest_id: "1207822149248962561",
									avatar: {
										image_url:
											"https://pbs.twimg.com/profile_images/1991573446875058176/y3pmE469_normal.jpg",
									},
									core: {
										screen_name: "enzo_gte",
										name: "enzo",
									},
									legacy: {
										followers_count: 13260,
										friends_count: 692,
									},
								},
							},
						},
					},
				},
			]),
		);

		const { lookupProfileViaBird } = await import("./bird");

		await expect(lookupProfileViaBird("enzo_gte")).resolves.toMatchObject({
			id: "1207822149248962561",
			username: "enzo_gte",
			profile_image_url:
				"https://pbs.twimg.com/profile_images/1991573446875058176/y3pmE469_normal.jpg",
		});
		expectBirdCommandCall(1, ["user", "enzo_gte", "--json", "--profile-only"]);
		expectBirdCommandCall(2, ["following", "-n", "1000", "--json"]);
		expectBirdCommandCall(3, [
			"user-tweets",
			"enzo_gte",
			"-n",
			"1",
			"--json-full",
		]);
	});

	it("rejects unexpected direct messages json", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		mockBirdStdoutOnce(
			JSON.stringify({
				success: false,
				conversations: [],
				events: [],
			}),
		);
		mockBirdStdoutOnce(
			JSON.stringify({
				success: true,
				conversations: {},
				events: [],
			}),
		);

		const { listDirectMessagesViaBird } = await import("./bird");

		await expect(listDirectMessagesViaBird({ maxResults: 5 })).rejects.toThrow(
			"bird dms returned unexpected JSON",
		);
		await expect(listDirectMessagesViaBird({ maxResults: 5 })).rejects.toThrow(
			"bird dms returned unexpected JSON",
		);
	});

	it("uses bird profiles for batch profile hydration", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		mockBirdStdoutOnce(
			JSON.stringify({
				users: [
					{
						id: "13334762",
						username: "github",
						name: "GitHub",
						description: "How people build software.",
						followersCount: 1,
						followingCount: 2,
						affiliation: { description: "GitHub" },
					},
				],
				errors: [{ target: "missing", error: "not found" }],
			}),
		);

		const { lookupProfilesViaBird } = await import("./bird");
		const results = await lookupProfilesViaBird(["@github", "missing"]);

		expectBirdCommandCall(1, ["profiles", "github", "missing", "--json"]);
		expect(results).toEqual([
			expect.objectContaining({
				target: "github",
				user: expect.objectContaining({
					id: "13334762",
					username: "github",
					description: "How people build software.",
					affiliation: { description: "GitHub" },
				}),
			}),
			{ target: "missing", user: null, error: "not found" },
		]);
	});

	it("falls back to bird following profiles when profiles is unavailable", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		mockBirdRejectOnce(
			Object.assign(new Error("unknown command profiles"), {
				stderr: "error: unknown command profiles",
			}),
		);
		mockBirdStdoutOnce(
			JSON.stringify([
				{
					id: "13334762",
					username: "github",
					name: "GitHub",
					profileImageUrl:
						"https://pbs.twimg.com/profile_images/13334762/github_normal.jpg",
				},
			]),
		);

		const { lookupProfilesViaBird } = await import("./bird");
		const results = await lookupProfilesViaBird(["github"]);

		expectBirdCommandCall(1, ["profiles", "github", "--json"]);
		expectBirdCommandCall(2, ["following", "-n", "1000", "--json"]);
		expect(results[0]?.user?.username).toBe("github");
		expect(results[0]?.user?.profile_image_url).toBe(
			"https://pbs.twimg.com/profile_images/13334762/github_normal.jpg",
		);
	});

	it("falls back to bird user-tweets raw profile data for non-followed profiles", async () => {
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/bird";
		mockBirdRejectOnce(
			Object.assign(new Error("unknown command profiles"), {
				stderr: "error: unknown command profiles",
			}),
		);
		mockBirdStdoutOnce(JSON.stringify([]));
		mockBirdRejectOnce(
			Object.assign(new Error("unknown command user"), {
				stderr: "error: unknown command user",
			}),
		);
		mockBirdStdoutOnce(
			JSON.stringify([
				{
					id: "2078102070482153717",
					text: "I've been using Kimi K3 for ~16 hours now.",
					createdAt: "Fri Jul 17 12:58:37 +0000 2026",
					authorId: "1207822149248962561",
					author: { username: "enzo_gte", name: "enzo" },
					_raw: {
						core: {
							user_results: {
								result: {
									rest_id: "1207822149248962561",
									avatar: {
										image_url:
											"https://pbs.twimg.com/profile_images/1991573446875058176/y3pmE469_normal.jpg",
									},
									core: {
										screen_name: "enzo_gte",
										name: "enzo",
									},
									legacy: {
										followers_count: 13260,
										friends_count: 692,
									},
								},
							},
						},
					},
				},
			]),
		);

		const { lookupProfilesViaBird } = await import("./bird");
		const results = await lookupProfilesViaBird(["enzo_gte"]);

		expectBirdCommandCall(1, ["profiles", "enzo_gte", "--json"]);
		expectBirdCommandCall(2, ["following", "-n", "1000", "--json"]);
		expectBirdCommandCall(3, ["user", "enzo_gte", "--json", "--profile-only"]);
		expectBirdCommandCall(4, [
			"user-tweets",
			"enzo_gte",
			"-n",
			"1",
			"--json-full",
		]);
		expect(results[0]?.user).toMatchObject({
			id: "1207822149248962561",
			username: "enzo_gte",
			profile_image_url:
				"https://pbs.twimg.com/profile_images/1991573446875058176/y3pmE469_normal.jpg",
			public_metrics: {
				followers_count: 13260,
				following_count: 692,
			},
		});
	});

	it("normalizes bird helper edge cases", async () => {
		const { __test__ } = await import("./bird");
		const enoent = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });

		expect(__test__.toIsoTimestamp("not-a-date")).toBe("not-a-date");
		expect(
			__test__.parseBirdJson('{"text":"hello\nworld","tab":"a\tb"}'),
		).toEqual({
			text: "hello\nworld",
			tab: "a\tb",
		});
		expect(__test__.formatBirdCommandError(enoent, "/missing/bird")).toEqual(
			expect.objectContaining({
				message: expect.stringContaining(
					"bird command unavailable: /missing/bird",
				),
			}),
		);
		expect(__test__.formatBirdCommandError("boom", "/tmp/bird")).toBe("boom");
		expect(
			__test__.isUnsupportedBirdOptionError(
				Object.assign(new Error("bad"), {
					stdout: "error: unknown option '--profile-only'",
				}),
				"--profile-only",
			),
		).toBe(true);
		expect(__test__.isUnsupportedBirdOptionError(null, "--profile-only")).toBe(
			false,
		);
		expect(__test__.getBirdTweetItems([{ id: "1" }], "mentions")).toEqual([
			{ id: "1" },
		]);
		expect(() => __test__.getBirdTweetItems({}, "mentions")).toThrow(
			"bird mentions returned unexpected JSON",
		);
		expect(() => __test__.getBirdTweetItem({}, "read")).toThrow(
			"bird read returned unexpected JSON",
		);
		expect(__test__.toMediaEntities(undefined)).toBeUndefined();
		expect(__test__.toMediaEntities([{ type: "photo" }])).toEqual({ urls: [] });
		expect(
			__test__.toReferencedTweets({
				id: "1",
				text: "hello",
				createdAt: "2026-05-01T00:00:00.000Z",
				quotedTweet: { id: "quoted" },
			}),
		).toEqual([{ type: "quoted", id: "quoted" }]);
		expect(
			__test__.normalizeBirdTweets([
				{
					id: "1",
					text: "hello",
					createdAt: "not-a-date",
					authorId: "42",
					author: { username: "sam" },
					media: [{ url: "https://img.example/a.jpg" }],
					article: {
						title: "A frontier without an ecosystem is not stable",
						previewText: "I have been thinking about the future of the firm.",
					},
					inReplyToStatusId: "",
				},
				{
					id: "2",
					text: "second",
					createdAt: "2026-05-01T00:00:00.000Z",
				},
			]),
		).toEqual(
			expect.objectContaining({
				data: [
					expect.objectContaining({
						id: "1",
						created_at: "not-a-date",
						conversation_id: "1",
						entities: expect.objectContaining({
							article: {
								title: "A frontier without an ecosystem is not stable",
								previewText:
									"I have been thinking about the future of the firm.",
								url: "https://x.com/sam/status/1",
							},
							urls: [
								expect.objectContaining({ url: "https://img.example/a.jpg" }),
							],
						}),
						referenced_tweets: undefined,
					}),
					expect.objectContaining({
						id: "2",
						author_id: "unknown",
					}),
				],
				meta: expect.objectContaining({
					result_count: 2,
					newest_id: "1",
					oldest_id: "2",
				}),
			}),
		);
	});
});
