// @vitest-environment node
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import {
	__test__,
	ensureDailyDigestPdf,
	ensureWeeklyDigestPdf,
} from "./daily-digest-pdf";
import { getNativeDb, resetDatabaseForTests } from "./db";
import {
	claimPeriodDigestDate,
	completePeriodDigestHistory,
	getPeriodDigestHistory,
	localWindowForDateKey,
} from "./period-digest-history";
import type { PeriodDigestRunResult } from "./period-digest";
import {
	claimWeeklyDigest,
	completeWeeklyDigestHistory,
	getWeeklyDigestHistory,
	localWindowForWeekStart,
} from "./weekly-digest-history";

const chromeAvailable = existsSync(
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
);
let temporaryHome = "";

beforeEach(() => {
	temporaryHome = mkdtempSync(path.join(os.tmpdir(), "birdclaw-pdf-"));
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

describe("daily digest PDF", () => {
	it.skipIf(!chromeAvailable)(
		"renders a private attachment from saved history without a web request",
		async () => {
			const date = "2026-07-31";
			const claim = claimPeriodDigestDate(date);
			if (!claim.claimed) throw new Error("Expected claim");
			const window = localWindowForDateKey(date);
			const result: PeriodDigestRunResult = {
				context: {
					window: { label: date, ...window },
					includeDms: false,
					counts: {
						home: 1,
						mentions: 0,
						authored: 0,
						likes: 0,
						bookmarks: 0,
						dms: 0,
						links: 0,
					},
					tweets: [],
					dms: [],
					links: [],
					hash: "pdf-hash",
				},
				digest: {
					title: "Private daily report",
					summary: "Rendered from the local history snapshot.",
					keyTopics: [],
					notableLinks: [],
					people: [],
					actionItems: [],
					sourceTweetIds: [],
				},
				markdown:
					"# Private daily report\n\n## What happened\n\n- Saved locally.",
				provider: "openai",
				model: "gpt-5.5",
				reasoningEffort: "medium",
				serviceTier: "priority",
				cached: false,
				updatedAt: "2026-08-01T00:01:00.000Z",
			};
			completePeriodDigestHistory(claim.id, claim.claimToken, result);

			const pdfPath = await ensureDailyDigestPdf({ id: claim.id });
			expect(readFileSync(pdfPath).subarray(0, 5).toString("ascii")).toBe(
				"%PDF-",
			);
			expect(statSync(pdfPath).size).toBeGreaterThan(1_000);
			expect(statSync(pdfPath).mode & 0o777).toBe(0o600);
			const original = getPeriodDigestHistory(claim.id);
			if (!original) throw new Error("Expected saved history");
			expect(await __test__.validCachedPdf(pdfPath, original)).toBe(true);

			getNativeDb()
				.prepare(
					`update period_digest_history
					 set markdown = ?, context_hash = ?, updated_at = ?
					 where id = ?`,
				)
				.run(
					"# Newer imported report",
					"newer-imported-hash",
					"2026-08-01T00:02:00.000Z",
					claim.id,
				);
			const imported = getPeriodDigestHistory(claim.id);
			if (!imported) throw new Error("Expected imported history");
			expect(await __test__.validCachedPdf(pdfPath, imported)).toBe(false);
		},
		60_000,
	);

	it.skipIf(!chromeAvailable)(
		"renders a natural-week attachment from weekly saved history",
		async () => {
			const weekStart = "2026-07-20";
			const claim = claimWeeklyDigest(weekStart);
			if (!claim.claimed) throw new Error("Expected weekly claim");
			const window = localWindowForWeekStart(weekStart);
			const result: PeriodDigestRunResult = {
				context: {
					window: {
						label: `${weekStart} – ${window.endDate}`,
						since: window.since,
						until: window.until,
					},
					includeDms: false,
					counts: {
						home: 7,
						mentions: 0,
						authored: 0,
						likes: 0,
						bookmarks: 0,
						dms: 0,
						links: 1,
					},
					tweets: [],
					dms: [],
					links: [],
					hash: "weekly-pdf-hash",
				},
				digest: {
					title: "Private weekly report",
					summary: "A complete Monday through Sunday archive.",
					keyTopics: [],
					notableLinks: [],
					people: [],
					actionItems: [],
					sourceTweetIds: [],
				},
				markdown:
					"# Private weekly report\n\n## What mattered\n\n- Saved locally.",
				provider: "openai",
				model: "gpt-5.5",
				reasoningEffort: "high",
				serviceTier: "priority",
				cached: false,
				updatedAt: "2026-07-27T00:01:00.000Z",
			};
			completeWeeklyDigestHistory(claim.id, claim.claimToken, result);

			const pdfPath = await ensureWeeklyDigestPdf({ id: claim.id });
			expect(pdfPath).toContain("/reports/weekly/");
			expect(readFileSync(pdfPath).subarray(0, 5).toString("ascii")).toBe(
				"%PDF-",
			);
			const original = getWeeklyDigestHistory(claim.id);
			if (!original) throw new Error("Expected saved weekly history");
			expect(await __test__.validCachedPdf(pdfPath, original)).toBe(true);
			expect(__test__.dailyDigestHtml(original)).toContain("Weekly archive");
			expect(__test__.dailyDigestHtml(original)).toContain(
				"2026-07-20 – 2026-07-26",
			);
		},
		60_000,
	);
});
