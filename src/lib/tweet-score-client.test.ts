// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	__test__,
	fetchTweetScores,
	requestTweetScore,
} from "./tweet-score-client";

function score(tweetId: string, value: number) {
	return {
		tweetId,
		score: value,
		label: "有限信息价值",
		dimensions: {
			informationDelta: value,
			clearThesis: 0,
			explainedMechanism: 0,
			verifiability: 0,
			clearBoundaries: 0,
		},
		sentiment: "neutral",
		assets: [],
		reason: "这是一条中文判断理由。",
		explanation: "这是便于理解的中文解释。",
		updatedAt: "2026-08-12T08:00:00.000Z",
		cached: true,
	};
}

describe("tweet score client", () => {
	afterEach(() => {
		__test__.resetForTests();
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("deduplicates inputs while preserving their original order", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					ok: true,
					scores: [score("tweet_2", 3), score("tweet_1", 2)],
				}),
			),
		);

		const scores = await fetchTweetScores([
			{ tweetId: "tweet_1", text: "One" },
			{ tweetId: "tweet_2", text: "Two" },
			{ tweetId: "tweet_1", text: "One" },
		]);

		expect(scores.map((item) => item.tweetId)).toEqual(["tweet_1", "tweet_2"]);
	});

	it("rejects incomplete batches so PDFs cannot silently omit a score", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ ok: true, scores: [] })),
		);

		await expect(
			fetchTweetScores([{ tweetId: "tweet_1", text: "One" }]),
		).rejects.toThrow("评分结果缺失：tweet_1");
	});

	it("shares one queued request for identical score inputs", async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn(async () =>
			Response.json({ ok: true, scores: [score("tweet_1", 2)] }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const input = {
			tweetId: "tweet_1",
			text: "One",
			author: { handle: "alice", displayName: "Alice" },
		};

		const first = requestTweetScore(input);
		const second = requestTweetScore({ ...input });
		expect(second).toBe(first);
		await vi.runAllTimersAsync();
		await expect(Promise.all([first, second])).resolves.toHaveLength(2);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
