// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "#/lib/config";
import { resetDatabaseForTests } from "#/lib/db";
import type { PeriodDigestRunResult } from "#/lib/period-digest";
import {
	claimWeeklyDigest,
	completeWeeklyDigestHistory,
	localWindowForWeekStart,
} from "#/lib/weekly-digest-history";
import { getRouteHandler } from "#/test/route-handlers";
import { Route } from "./weekly-digest-history";

const GET = getRouteHandler(Route, "GET");
let temporaryHome = "";

beforeEach(() => {
	temporaryHome = mkdtempSync(
		path.join(os.tmpdir(), "birdclaw-weekly-history-api-"),
	);
	process.env.BIRDCLAW_HOME = temporaryHome;
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
});

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	rmSync(temporaryHome, { recursive: true, force: true });
});

function saveHistory() {
	const weekStart = "2026-07-20";
	const claim = claimWeeklyDigest(weekStart);
	if (!claim.claimed) throw new Error("Expected claim");
	const window = localWindowForWeekStart(weekStart);
	const result: PeriodDigestRunResult = {
		context: {
			window: { label: weekStart, since: window.since, until: window.until },
			includeDms: false,
			counts: {
				home: 50,
				mentions: 0,
				authored: 0,
				likes: 0,
				bookmarks: 0,
				dms: 0,
				links: 4,
			},
			tweets: [],
			dms: [],
			links: [],
			hash: "weekly-history-api-hash",
		},
		digest: {
			title: "July 20–26 report",
			summary: "Saved automatically.",
			keyTopics: [],
			notableLinks: [],
			people: [],
			actionItems: [],
			sourceTweetIds: [],
		},
		markdown: "# July 20–26 report",
		provider: "openai",
		model: "gpt-5.5",
		reasoningEffort: "high",
		serviceTier: "priority",
		cached: false,
		updatedAt: "2026-07-27T00:01:00.000Z",
	};
	completeWeeklyDigestHistory(claim.id, claim.claimToken, result);
	return claim.id;
}

describe("weekly digest history API", () => {
	it("lists metadata and restores the saved result", async () => {
		const id = saveHistory();
		const listResponse = await GET({
			request: new Request("http://localhost/api/weekly-digest-history"),
		});
		expect(listResponse.status).toBe(200);
		expect(await listResponse.json()).toMatchObject({
			items: [
				{
					id,
					kind: "weekly",
					date: "2026-07-20",
					endDate: "2026-07-26",
					status: "ready",
					title: "July 20–26 report",
					pdfAvailable: false,
				},
			],
		});

		const detailResponse = await GET({
			request: new Request(
				`http://localhost/api/weekly-digest-history?id=${id}`,
			),
		});
		expect(detailResponse.status).toBe(200);
		expect(await detailResponse.json()).toMatchObject({
			item: {
				metadata: { id, kind: "weekly", status: "ready" },
				result: {
					markdown: "# July 20–26 report",
					cached: true,
					reasoningEffort: "high",
				},
			},
		});
	});

	it("returns 404 for missing history", async () => {
		const response = await GET({
			request: new Request(
				"http://localhost/api/weekly-digest-history?id=missing",
			),
		});
		expect(response.status).toBe(404);
	});
});
