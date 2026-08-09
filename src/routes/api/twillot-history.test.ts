// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "#/lib/config";
import { resetDatabaseForTests } from "#/lib/db";
import { getRouteHandler } from "#/test/route-handlers";
import { Route } from "./twillot-history";

const GET = getRouteHandler(Route, "GET");
const POST = getRouteHandler(Route, "POST");
const tempRoots: string[] = [];

beforeEach(() => {
	const root = mkdtempSync(path.join(os.tmpdir(), "birdclaw-twillot-api-"));
	tempRoots.push(root);
	process.env.BIRDCLAW_HOME = root;
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
});

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("Twillot history management API", () => {
	it("reports the Mini soft budget without exposing a token", async () => {
		const response = await GET({
			request: new Request("http://127.0.0.1:3001/api/twillot-history"),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			endpoint: "http://127.0.0.1:3001/api/integrations/twillot-history",
			localQueueExecutor: true,
			managementAvailable: true,
			status: {
				plan: "Mini",
				monthlyPriceUsd: 4.99,
				dailyLimit: 20_000,
				softBudget: true,
				companion: { paired: false },
			},
		});
	});

	it("returns a one-time pairing token and never echoes it on GET", async () => {
		const paired = await POST({
			request: new Request("http://127.0.0.1:3001/api/twillot-history", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "pair" }),
			}),
		});
		const pairing = (await paired.json()) as { token: string };
		expect(pairing.token).toHaveLength(43);

		const status = await GET({
			request: new Request("http://127.0.0.1:3001/api/twillot-history"),
		});
		const body = await status.json();
		expect(body.status.companion.paired).toBe(true);
		expect(body.token).toBeUndefined();
		expect(JSON.stringify(body)).not.toContain(pairing.token);
	});

	it("keeps companion management on the Mac when Settings is opened remotely", async () => {
		const status = await GET({
			request: new Request("https://birdclaw.example/api/twillot-history"),
		});
		expect(await status.json()).toMatchObject({
			ok: true,
			localQueueExecutor: true,
			managementAvailable: false,
			endpoint: "http://127.0.0.1:3001/api/integrations/twillot-history",
		});

		const response = await POST({
			request: new Request("https://birdclaw.example/api/twillot-history", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "pair" }),
			}),
		});
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ ok: false });
	});

	it("rejects invalid management requests", async () => {
		const invalid = await POST({
			request: new Request("http://127.0.0.1:3001/api/twillot-history", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "not-json",
			}),
		});
		expect(invalid.status).toBe(400);
	});

	it("disconnects a paired companion and maps invalid job transitions to conflict", async () => {
		const url = "http://127.0.0.1:3001/api/twillot-history";
		await POST({
			request: new Request(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "pair" }),
			}),
		});
		const disconnected = await POST({
			request: new Request(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "disconnect" }),
			}),
		});
		expect(await disconnected.json()).toMatchObject({
			ok: true,
			status: { companion: { paired: false } },
		});
		const conflict = await POST({
			request: new Request(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					action: "retry",
					jobId: "00000000-0000-4000-8000-000000000000",
				}),
			}),
		});
		expect(conflict.status).toBe(409);
	});
});
