// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
	insertTestAccount,
	insertTestProfile,
	useTestHome,
} from "#/test/test-home";
import { getRouteHandler } from "#/test/route-handlers";
import { createProfileList } from "#/lib/profile-lists";
import { Route } from "./list-members";

const GET = getRouteHandler(Route, "GET");
const PATCH = getRouteHandler(Route, "PATCH");

describe("List members API", () => {
	const getHome = useTestHome({ prefix: "birdclaw-list-members-api-" });

	it("adds, searches, reports, and removes a member without exposing secrets", async () => {
		const { db } = getHome();
		insertTestAccount(db, { id: "acct" });
		insertTestProfile(db, {
			id: "profile_user_42",
			handle: "facts_wire",
			displayName: "Facts Wire",
		});
		const list = createProfileList({ accountId: "acct", name: "Facts" }, db);
		const mutation = (included: boolean) =>
			PATCH({
				request: new Request("http://localhost/api/list-members", {
					method: "PATCH",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						accountId: "acct",
						listId: list.id,
						handle: "facts_wire",
						identifier: "profile_user_42",
						included,
					}),
				}),
			});

		expect((await mutation(true)).status).toBe(200);
		const members = await GET({
			request: new Request(
				`http://localhost/api/list-members?account=acct&listId=${list.id}&search=facts`,
			),
		});
		await expect(members.json()).resolves.toMatchObject({
			members: [{ handle: "facts_wire", identifier: "42" }],
			candidates: [{ included: true, profile: { handle: "facts_wire" } }],
		});
		const status = await GET({
			request: new Request(
				"http://localhost/api/list-members?account=acct&profileHandle=facts_wire&identifier=profile_user_42",
			),
		});
		await expect(status.json()).resolves.toMatchObject({
			lists: [{ id: list.id, included: true }],
		});
		expect((await mutation(false)).status).toBe(200);
	});

	it("rejects invalid membership writes", async () => {
		const response = await PATCH({
			request: new Request("http://localhost/api/list-members", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ included: "yes" }),
			}),
		});
		expect(response.status).toBe(400);
	});
});
