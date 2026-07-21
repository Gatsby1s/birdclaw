// @vitest-environment node
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";

const expandRetweetedTextViaBirdMock = vi.fn();

vi.mock("#/lib/bird", () => ({
	expandRetweetedTextViaBird: (...args: unknown[]) =>
		expandRetweetedTextViaBirdMock(...args),
	expandRetweetedTextViaBirdEffect: (...args: unknown[]) =>
		Effect.tryPromise({
			try: () => Promise.resolve(expandRetweetedTextViaBirdMock(...args)),
			catch: (error) => error,
		}),
}));

import { Route } from "./tweet-expand";

const GET = getRouteHandler(Route, "GET");

describe("api tweet expand route", () => {
	beforeEach(() => {
		expandRetweetedTextViaBirdMock.mockReset();
	});

	it("returns the expanded original repost text", async () => {
		expandRetweetedTextViaBirdMock.mockResolvedValue({
			tweetId: "2012345678901234567",
			sourceTweetId: "2098765432109876543",
			text: "The complete long repost",
		});

		const response = await GET({
			request: new Request(
				"http://localhost/api/tweet-expand?tweetId=%202012345678901234567%20",
			),
		});

		expect(expandRetweetedTextViaBirdMock).toHaveBeenCalledWith(
			"2012345678901234567",
		);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			ok: true,
			tweetId: "2012345678901234567",
			sourceTweetId: "2098765432109876543",
			text: "The complete long repost",
		});
	});

	it("rejects a missing tweet id without invoking bird", async () => {
		const response = await GET({
			request: new Request("http://localhost/api/tweet-expand"),
		});

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			message: "Missing tweetId",
		});
		expect(expandRetweetedTextViaBirdMock).not.toHaveBeenCalled();
	});

	it("rejects a non-numeric tweet id before invoking bird", async () => {
		const response = await GET({
			request: new Request(
				"http://localhost/api/tweet-expand?tweetId=wrapper_1",
			),
		});

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			message: "Invalid tweetId",
		});
		expect(expandRetweetedTextViaBirdMock).not.toHaveBeenCalled();
	});

	it("returns a safe upstream error without exposing bird output", async () => {
		expandRetweetedTextViaBirdMock.mockRejectedValue(
			new Error("bird stderr contained private credentials"),
		);

		const response = await GET({
			request: new Request(
				"http://localhost/api/tweet-expand?tweetId=2012345678901234567",
			),
		});

		expect(response.status).toBe(502);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			message: "Full repost unavailable",
		});
	});
});
