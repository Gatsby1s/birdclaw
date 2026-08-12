// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
	insertTestAccount,
	insertTestProfile,
	insertTestTweet,
	useTestHome,
} from "#/test/test-home";
import { setProfileSpecialFollow } from "#/lib/profile-priority";
import { Route } from "./special-follow-position";

type Handler = (context: { request: Request }) => Response | Promise<Response>;

function routeHandler(method: "GET" | "PATCH") {
	const handlers = Route.options.server?.handlers as unknown as Record<
		"GET" | "PATCH",
		Handler
	>;
	return handlers[method];
}

const GET = routeHandler("GET");
const PATCH = routeHandler("PATCH");

describe("special-follow position API", () => {
	const getHome = useTestHome({ prefix: "birdclaw-special-position-route-" });

	it("writes, reads, and reports a cross-session revision conflict", async () => {
		const { db } = getHome();
		insertTestAccount(db, { id: "acct" });
		insertTestProfile(db, { id: "profile_user_42", handle: "ada" });
		insertTestTweet(db, {
			id: "tweet_1",
			authorProfileId: "profile_user_42",
			createdAt: "2026-08-01T01:00:00.000Z",
		});
		db.prepare(
			`insert into tweet_account_edges (
			   account_id, tweet_id, kind, first_seen_at, last_seen_at,
			   seen_count, source, raw_json, updated_at
			 ) values ('acct', 'tweet_1', 'home', ?, ?, 1, 'test', '{}', ?)`,
		).run(
			"2026-08-01T01:00:00.000Z",
			"2026-08-01T01:00:00.000Z",
			"2026-08-01T01:00:00.000Z",
		);
		setProfileSpecialFollow(
			{
				handle: "ada",
				identifier: "profile_user_42",
				specialFollow: true,
			},
			db,
		);

		const first = await PATCH({
			request: new Request("http://localhost/api/special-follow-position", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					accountId: "acct",
					anchorTweetId: "tweet_1",
					pixelOffset: 15,
					clientSessionId: "desktop",
					clientSequence: 1,
					expectedRevision: 0,
				}),
			}),
		});
		expect(first.status).toBe(200);
		expect(await first.json()).toMatchObject({
			ok: true,
			applied: true,
			position: { revision: 1 },
		});

		const conflict = await PATCH({
			request: new Request("http://localhost/api/special-follow-position", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					accountId: "acct",
					anchorTweetId: "tweet_1",
					pixelOffset: 0,
					clientSessionId: "phone",
					clientSequence: 1,
					expectedRevision: 0,
				}),
			}),
		});
		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toMatchObject({
			ok: false,
			applied: false,
			conflict: true,
			position: { revision: 1, clientSessionId: "desktop" },
		});

		const read = await GET({
			request: new Request(
				"http://localhost/api/special-follow-position?account=acct",
			),
		});
		expect(await read.json()).toMatchObject({
			accountId: "acct",
			viewKey: "special-follow",
			position: { anchorTweetId: "tweet_1", revision: 1 },
		});
	});

	it("rejects malformed writes", async () => {
		getHome();
		const response = await PATCH({
			request: new Request("http://localhost/api/special-follow-position", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ accountId: "acct" }),
			}),
		});
		expect(response.status).toBe(400);
	});
});
