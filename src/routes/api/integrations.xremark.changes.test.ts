// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "#/lib/config";
import { resetDatabaseForTests } from "#/lib/db";
import {
	applyXRemarkLiveSnapshot,
	createXRemarkPairing,
	XREMARK_EXTENSION_ORIGIN,
} from "#/lib/xremark-live";
import { getXRemarkSyncStatus, saveBirdclawProfileRemark } from "#/lib/xremark";
import { Route } from "./integrations.xremark.changes";

type Handler = (context: { request: Request }) => Response | Promise<Response>;

function handler(method: "GET" | "POST" | "OPTIONS") {
	const handlers = Route.options.server?.handlers;
	if (!handlers) throw new Error("X Remark changes handlers are unavailable");
	return (handlers as unknown as Record<string, Handler>)[method];
}

function request(token: string, method: "GET" | "POST", body?: unknown) {
	return new Request(
		"https://birdclaw-production.up.railway.app/api/integrations/xremark/changes",
		{
			method,
			headers: {
				origin: XREMARK_EXTENSION_ORIGIN,
				authorization: `Bearer ${token}`,
				...(body ? { "content-type": "application/json" } : {}),
			},
			...(body ? { body: JSON.stringify(body) } : {}),
		},
	);
}

let tempDir = "";

beforeEach(() => {
	tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-xremark-changes-"));
	process.env.BIRDCLAW_HOME = tempDir;
	resetBirdclawPathsForTests();
});

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	rmSync(tempDir, { recursive: true, force: true });
});

describe("X Remark outbound changes API", () => {
	it("delivers a full tag-aware change and clears it only after acknowledgement", async () => {
		const { token } = createXRemarkPairing();
		saveBirdclawProfileRemark({
			identifier: "profile_user_42",
			handle: "ada",
			remark: "Momentum trader",
			description: "Tracks liquid majors",
			tags: ["交易员", "分析师", "交易员"],
		});

		const delivered = await handler("GET")({ request: request(token, "GET") });
		expect(delivered.status).toBe(200);
		const body = await delivered.json();
		expect(body).toMatchObject({
			ok: true,
			latestRevision: 1,
			changes: [
				{
					revision: 1,
					identifier: "42",
					handle: "ada",
					remark: "Momentum trader",
					description: "Tracks liquid majors",
					tags: ["交易员", "分析师"],
					base: { exists: false },
				},
			],
		});

		applyXRemarkLiveSnapshot({
			sourceId: "source_changes_1",
			sequence: 1,
			capturedAt: 1_776_000_000_000,
			database: {
				name: "xRemark",
				version: 1,
				backupID: "changes_1",
				backupTime: 1_776_000_000_000,
			},
			remarks: [
				{
					identifier: "42",
					additionalName: "ada",
					givenName: "Ada",
					remark: "Momentum trader",
					description: "Tracks liquid majors",
					tags: ["tag-trader", "tag-analyst"],
				},
			],
			tags: [
				{ id: "tag-trader", name: "交易员" },
				{ id: "tag-analyst", name: "分析师" },
			],
			categories: [],
		});
		const acknowledged = await handler("POST")({
			request: request(token, "POST", { applied: [1], conflicts: [] }),
		});
		expect(acknowledged.status).toBe(200);
		expect(await acknowledged.json()).toMatchObject({ changes: [] });
		expect(getXRemarkSyncStatus({ identifier: "42" }).annotation).toMatchObject(
			{
				remark: "Momentum trader",
				tags: ["交易员", "分析师"],
			},
		);
	});

	it("requires the exact extension origin and pairing token", async () => {
		const { token } = createXRemarkPairing();
		const wrongOrigin = new Request(
			"https://birdclaw-production.up.railway.app/api/integrations/xremark/changes",
			{
				headers: {
					origin: "https://x.com",
					authorization: `Bearer ${token}`,
				},
			},
		);
		expect((await handler("GET")({ request: wrongOrigin })).status).toBe(403);
		expect(
			(await handler("GET")({ request: request(`${token}x`, "GET") })).status,
		).toBe(401);
	});
});
