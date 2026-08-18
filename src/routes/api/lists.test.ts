// @vitest-environment node
import { describe, expect, it } from "vitest";
import { insertTestAccount, useTestHome } from "#/test/test-home";
import { getRouteHandler } from "#/test/route-handlers";
import { Route } from "./lists";

const GET = getRouteHandler(Route, "GET");
const POST = getRouteHandler(Route, "POST");
const PATCH = getRouteHandler(Route, "PATCH");
const DELETE = getRouteHandler(Route, "DELETE");

function jsonRequest(method: "POST" | "PATCH" | "DELETE", body: unknown) {
	return new Request("http://localhost/api/lists", {
		method,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("Lists API", () => {
	const getHome = useTestHome({ prefix: "birdclaw-lists-api-" });

	it("creates, reads, renames, and deletes an account-scoped List", async () => {
		insertTestAccount(getHome().db, { id: "acct" });
		const created = await POST({
			request: jsonRequest("POST", {
				accountId: "acct",
				name: "Facts",
				description: "Company sources",
			}),
		});
		expect(created.status).toBe(201);
		const list = (await created.json()) as { id: string };

		const collection = await GET({
			request: new Request("http://localhost/api/lists?account=acct"),
		});
		await expect(collection.json()).resolves.toMatchObject({
			lists: [{ id: list.id, name: "Facts", memberCount: 0 }],
		});

		const renamed = await PATCH({
			request: jsonRequest("PATCH", {
				accountId: "acct",
				listId: list.id,
				name: "Newsrooms",
			}),
		});
		await expect(renamed.json()).resolves.toMatchObject({ name: "Newsrooms" });

		const removed = await DELETE({
			request: jsonRequest("DELETE", { accountId: "acct", listId: list.id }),
		});
		expect(removed.status).toBe(200);
		const empty = await GET({
			request: new Request("http://localhost/api/lists?account=acct"),
		});
		await expect(empty.json()).resolves.toEqual({ lists: [] });
	});

	it("rejects malformed input and cross-account updates", async () => {
		const { db } = getHome();
		insertTestAccount(db, { id: "acct" });
		insertTestAccount(db, { id: "other", handle: "@other" });
		const invalid = await POST({
			request: jsonRequest("POST", { accountId: "acct", name: "" }),
		});
		expect(invalid.status).toBe(400);
		const created = await POST({
			request: jsonRequest("POST", { accountId: "acct", name: "Private" }),
		});
		const list = (await created.json()) as { id: string };
		const denied = await PATCH({
			request: jsonRequest("PATCH", {
				accountId: "other",
				listId: list.id,
				name: "Stolen",
			}),
		});
		expect(denied.status).toBe(404);
	});
});
