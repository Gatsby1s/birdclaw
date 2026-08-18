// @vitest-environment node
import { describe, expect, it } from "vitest";
import { insertTestAccount, useTestHome } from "#/test/test-home";
import { getRouteHandler } from "#/test/route-handlers";
import { createProfileList } from "#/lib/profile-lists";
import { Route } from "./list-feed";

const GET = getRouteHandler(Route, "GET");

describe("List feed API", () => {
	const getHome = useTestHome({ prefix: "birdclaw-list-feed-api-" });

	it("returns an empty member-filtered feed for a new List", async () => {
		const { db } = getHome();
		insertTestAccount(db, { id: "acct" });
		const list = createProfileList({ accountId: "acct", name: "Facts" }, db);
		const response = await GET({
			request: new Request(
				`http://localhost/api/list-feed?account=acct&listId=${list.id}`,
			),
		});
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			list: { id: list.id },
			items: [],
			hasMore: false,
		});
	});

	it("does not reveal whether another account owns a missing List", async () => {
		insertTestAccount(getHome().db, { id: "acct" });
		const response = await GET({
			request: new Request(
				"http://localhost/api/list-feed?account=acct&listId=missing",
			),
		});
		expect(response.status).toBe(404);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			message: "List timeline unavailable.",
		});
	});
});
