// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";

const setLocalBookmarkMock = vi.fn();

vi.mock("#/lib/local-bookmarks", async () => {
	const { Effect } = await import("effect");
	return {
		setLocalBookmarkEffect: (...args: unknown[]) =>
			Effect.sync(() => setLocalBookmarkMock(...args)),
	};
});

import { Route } from "./bookmark";

const POST = getRouteHandler(Route, "POST");

describe("bookmark api route", () => {
	beforeEach(() => {
		setLocalBookmarkMock.mockReset();
	});

	it("validates and writes a local bookmark", async () => {
		setLocalBookmarkMock.mockReturnValue({
			ok: true,
			accountId: "acct_primary",
			tweetId: "tweet_1",
			bookmarked: true,
		});

		const response = await POST({
			request: new Request("http://localhost/api/bookmark", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					accountId: "acct_primary",
					tweetId: "tweet_1",
					bookmarked: true,
				}),
			}),
		});

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			ok: true,
			tweetId: "tweet_1",
			bookmarked: true,
		});
		expect(setLocalBookmarkMock).toHaveBeenCalledWith({
			accountId: "acct_primary",
			tweetId: "tweet_1",
			bookmarked: true,
		});
	});

	it("rejects malformed and missing records", async () => {
		const invalid = await POST({
			request: new Request("http://localhost/api/bookmark", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ tweetId: "tweet_1", bookmarked: true }),
			}),
		});
		expect(invalid.status).toBe(400);

		setLocalBookmarkMock.mockReturnValue({
			ok: false,
			reason: "tweet-not-found",
		});
		const missing = await POST({
			request: new Request("http://localhost/api/bookmark", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					accountId: "acct_primary",
					tweetId: "missing",
					bookmarked: true,
				}),
			}),
		});
		expect(missing.status).toBe(404);
	});
});
