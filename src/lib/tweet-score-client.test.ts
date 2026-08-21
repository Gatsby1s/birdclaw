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

	it("keeps later score batches behind an in-flight batch", async () => {
		vi.useFakeTimers();
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const fetchMock = vi
			.fn()
			.mockImplementationOnce(async () => {
				await firstGate;
				return Response.json({ ok: true, scores: [score("tweet_1", 2)] });
			})
			.mockResolvedValueOnce(
				Response.json({ ok: true, scores: [score("tweet_2", 3)] }),
			);
		vi.stubGlobal("fetch", fetchMock);
		const first = requestTweetScore({ tweetId: "tweet_1", text: "One" });

		await vi.advanceTimersByTimeAsync(24);
		expect(fetchMock).toHaveBeenCalledOnce();
		const second = requestTweetScore({ tweetId: "tweet_2", text: "Two" });
		await vi.advanceTimersByTimeAsync(100);
		expect(fetchMock).toHaveBeenCalledOnce();

		releaseFirst();
		await expect(first).resolves.toMatchObject({ tweetId: "tweet_1" });
		await vi.advanceTimersByTimeAsync(24);
		await expect(second).resolves.toMatchObject({ tweetId: "tweet_2" });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("removes an aborted queued score before a batch reaches the server", async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const controller = new AbortController();
		const request = requestTweetScore(
			{ tweetId: "tweet_cancelled", text: "Do not send" },
			controller.signal,
		);

		controller.abort();
		await expect(request).rejects.toMatchObject({ name: "AbortError" });
		await vi.runAllTimersAsync();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("aborts the batch fetch after every participating score is cancelled", async () => {
		vi.useFakeTimers();
		let fetchSignal: AbortSignal | undefined;
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				fetchSignal = init?.signal ?? undefined;
				return new Promise<Response>((_resolve, reject) => {
					fetchSignal?.addEventListener(
						"abort",
						() => reject(new DOMException("cancelled", "AbortError")),
						{ once: true },
					);
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		const firstController = new AbortController();
		const secondController = new AbortController();
		const first = requestTweetScore(
			{ tweetId: "tweet_1", text: "One" },
			firstController.signal,
		);
		const second = requestTweetScore(
			{ tweetId: "tweet_2", text: "Two" },
			secondController.signal,
		);

		await vi.runAllTimersAsync();
		expect(fetchMock).toHaveBeenCalledOnce();
		firstController.abort();
		expect(fetchSignal?.aborted).toBe(false);
		secondController.abort();
		await expect(first).rejects.toMatchObject({ name: "AbortError" });
		await expect(second).rejects.toMatchObject({ name: "AbortError" });
		expect(fetchSignal?.aborted).toBe(true);
	});
});
