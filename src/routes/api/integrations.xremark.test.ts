// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "#/lib/config";
import { resetDatabaseForTests } from "#/lib/db";
import { Route } from "./integrations.xremark";

type Handler = (context: { request: Request }) => Response | Promise<Response>;

function handler(method: "GET" | "POST") {
	const handlers = Route.options.server?.handlers as unknown as Record<
		"GET" | "POST",
		Handler
	>;
	return handlers[method];
}

let tempDir = "";

beforeEach(() => {
	tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-xremark-pair-route-"));
	process.env.BIRDCLAW_HOME = tempDir;
	resetBirdclawPathsForTests();
});

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	rmSync(tempDir, { recursive: true, force: true });
});

describe("X Remark live sync management API", () => {
	it("creates a one-time pairing token and disconnects", async () => {
		const pair = await handler("POST")({
			request: new Request("http://localhost/api/integrations/xremark", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "pair" }),
			}),
		});
		expect(pair.status).toBe(200);
		const pairing = (await pair.json()) as { token: string };
		expect(pairing.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);

		const status = await handler("GET")({
			request: new Request("http://localhost/api/integrations/xremark"),
		});
		const statusText = await status.text();
		expect(JSON.parse(statusText)).toMatchObject({
			paired: true,
			connected: false,
		});
		expect(statusText).not.toContain(pairing.token);

		const disconnected = await handler("POST")({
			request: new Request("http://localhost/api/integrations/xremark", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "disconnect" }),
			}),
		});
		expect(await disconnected.json()).toMatchObject({ paired: false });
	});
});
