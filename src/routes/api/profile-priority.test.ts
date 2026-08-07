// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "#/lib/config";
import { resetDatabaseForTests } from "#/lib/db";
import { Route } from "./profile-priority";

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
let tempDir = "";

beforeEach(() => {
	tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-priority-route-"));
	process.env.BIRDCLAW_HOME = tempDir;
	resetBirdclawPathsForTests();
});

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	rmSync(tempDir, { recursive: true, force: true });
});

describe("profile priority API", () => {
	it("toggles a special follow and reads it back", async () => {
		const saved = await PATCH({
			request: new Request("http://localhost/api/profile-priority", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					handle: "Ada",
					identifier: "profile_user_42",
					specialFollow: true,
				}),
			}),
		});
		expect(saved.status).toBe(200);
		expect(await saved.json()).toMatchObject({
			handle: "ada",
			identifier: "42",
			specialFollow: true,
		});

		const lookup = await GET({
			request: new Request(
				"http://localhost/api/profile-priority?handle=ada&identifier=profile_user_42",
			),
		});
		expect(await lookup.json()).toMatchObject({ specialFollow: true });
	});

	it("promotes a newer handle-only choice when the stable ID becomes available", async () => {
		await PATCH({
			request: new Request("http://localhost/api/profile-priority", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ handle: "Ada", specialFollow: true }),
			}),
		});

		const promoted = await GET({
			request: new Request(
				"http://localhost/api/profile-priority?handle=ada&identifier=profile_user_42",
			),
		});
		expect(await promoted.json()).toMatchObject({
			identifier: "42",
			specialFollow: true,
		});

		const provisional = await GET({
			request: new Request("http://localhost/api/profile-priority?handle=ada"),
		});
		expect(await provisional.json()).toMatchObject({ specialFollow: false });
	});

	it("rejects malformed mutations", async () => {
		const response = await PATCH({
			request: new Request("http://localhost/api/profile-priority", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ handle: "ada", specialFollow: "yes" }),
			}),
		});
		expect(response.status).toBe(400);
	});
});
