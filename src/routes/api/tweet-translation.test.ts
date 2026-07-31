// @vitest-environment node
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";

const translateTweetTextEffectMock = vi.fn();

vi.mock("#/lib/tweet-translation", () => ({
	translateTweetTextEffect: (...args: unknown[]) =>
		translateTweetTextEffectMock(...args),
}));

import { Route } from "./tweet-translation";

const POST = getRouteHandler(Route, "POST");

describe("api tweet translation route", () => {
	beforeEach(() => {
		translateTweetTextEffectMock.mockReset();
	});

	it("translates a valid post into Simplified Chinese", async () => {
		translateTweetTextEffectMock.mockReturnValue(
			Effect.succeed({
				targetLanguage: "zh-CN",
				sourceLanguage: "English",
				translated: true,
				translatedText: "今天发布新版本。",
				cached: false,
			}),
		);

		const response = await POST({
			request: new Request("http://localhost/api/tweet-translation", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					tweetId: "tweet_1",
					text: "Shipping the new release today.",
					targetLanguage: "zh-CN",
				}),
			}),
		});

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			ok: true,
			tweetId: "tweet_1",
			targetLanguage: "zh-CN",
			sourceLanguage: "English",
			translated: true,
			translatedText: "今天发布新版本。",
			cached: false,
		});
		expect(translateTweetTextEffectMock).toHaveBeenCalledWith(
			"Shipping the new release today.",
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	it("rejects malformed requests before invoking the model", async () => {
		const response = await POST({
			request: new Request("http://localhost/api/tweet-translation", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					tweetId: "",
					text: "",
					targetLanguage: "en",
				}),
			}),
		});

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			message: "Invalid translation request",
		});
		expect(translateTweetTextEffectMock).not.toHaveBeenCalled();
	});

	it("returns a safe error without exposing provider details", async () => {
		translateTweetTextEffectMock.mockReturnValue(
			Effect.fail(new Error("provider response included sk-private-value")),
		);

		const response = await POST({
			request: new Request("http://localhost/api/tweet-translation", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					tweetId: "tweet_1",
					text: "Translate this post.",
				}),
			}),
		});

		expect(response.status).toBe(502);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			message: "Translation temporarily unavailable",
		});
	});
});
