// @vitest-environment node
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";

const scoreTweetsEffectMock = vi.fn();

vi.mock("#/lib/tweet-score", () => ({
	scoreTweetsEffect: (...args: unknown[]) => scoreTweetsEffectMock(...args),
}));

import { Route } from "./tweet-scores";

const POST = getRouteHandler(Route, "POST");

describe("api tweet scores route", () => {
	beforeEach(() => scoreTweetsEffectMock.mockReset());

	it("returns a batch of persisted Chinese scores", async () => {
		scoreTweetsEffectMock.mockReturnValue(
			Effect.succeed([
				{
					tweetId: "tweet_1",
					score: 8,
					label: "高信息价值",
					dimensions: {
						informationDelta: 4,
						clearThesis: 2,
						explainedMechanism: 1,
						verifiability: 1,
						clearBoundaries: 0,
					},
					sentiment: "positive",
					assets: ["股票"],
					reason: "包含新信息和明确判断。",
					explanation: "作者用数据说明股票可能上涨。",
					updatedAt: "2026-08-12T08:00:00.000Z",
					cached: false,
				},
			]),
		);
		const response = await POST({
			request: new Request("http://localhost/api/tweet-scores", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					tweets: [{ tweetId: "tweet_1", text: "A specific claim" }],
				}),
			}),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			scores: [{ tweetId: "tweet_1", score: 8 }],
		});
		expect(scoreTweetsEffectMock).toHaveBeenCalledWith(
			[{ tweetId: "tweet_1", text: "A specific claim" }],
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	it("rejects malformed batches before invoking the model", async () => {
		const response = await POST({
			request: new Request("http://localhost/api/tweet-scores", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ tweets: [] }),
			}),
		});
		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			message: "评分请求无效",
		});
		expect(scoreTweetsEffectMock).not.toHaveBeenCalled();
	});

	it("does not expose provider errors", async () => {
		scoreTweetsEffectMock.mockReturnValue(
			Effect.fail(new Error("provider leaked sk-private")),
		);
		const response = await POST({
			request: new Request("http://localhost/api/tweet-scores", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					tweets: [{ tweetId: "tweet_1", text: "A specific claim" }],
				}),
			}),
		});
		expect(response.status).toBe(502);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			message: "评分暂时不可用",
		});
	});
});
