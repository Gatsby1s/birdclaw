// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import {
	claimPeriodDigestDate,
	completePeriodDigestHistory,
	failPeriodDigestHistory,
	getPeriodDigestHistory,
	listPeriodDigestHistory,
	localWindowForDateKey,
} from "./period-digest-history";
import type { PeriodDigestRunResult } from "./period-digest";

let temporaryHome = "";
let originalTimezone: string | undefined;

function resultForDate(date: string): PeriodDigestRunResult {
	const window = localWindowForDateKey(date);
	return {
		context: {
			window: { label: date, ...window },
			includeDms: false,
			counts: {
				home: 4,
				mentions: 1,
				authored: 0,
				likes: 0,
				bookmarks: 0,
				dms: 0,
				links: 2,
			},
			tweets: [],
			dms: [],
			links: [],
			hash: `hash-${date}`,
		},
		digest: {
			title: `Digest ${date}`,
			summary: "Saved once and restored without model usage.",
			keyTopics: [],
			notableLinks: [],
			people: [],
			actionItems: [],
			sourceTweetIds: [],
		},
		markdown: `# Digest ${date}\n\nSaved report.`,
		provider: "openai",
		model: "gpt-5.5",
		reasoningEffort: "medium",
		serviceTier: "priority",
		cached: false,
		updatedAt: new Date().toISOString(),
	};
}

beforeEach(() => {
	temporaryHome = mkdtempSync(
		path.join(os.tmpdir(), "birdclaw-daily-history-"),
	);
	originalTimezone = process.env.TZ;
	process.env.BIRDCLAW_HOME = temporaryHome;
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
});

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	if (originalTimezone === undefined) delete process.env.TZ;
	else process.env.TZ = originalTimezone;
	rmSync(temporaryHome, { recursive: true, force: true });
});

describe("daily period digest history", () => {
	it("claims one generator per day and restores a completed report", () => {
		const first = claimPeriodDigestDate("2026-07-31");
		expect(first.claimed).toBe(true);
		const duplicate = claimPeriodDigestDate("2026-07-31");
		expect(duplicate).toMatchObject({
			claimed: false,
			id: first.id,
			status: "pending",
		});
		if (!first.claimed) throw new Error("Expected the first claim to win");
		expect(
			completePeriodDigestHistory(
				first.id,
				first.claimToken,
				resultForDate("2026-07-31"),
			),
		).toBe(true);

		const detail = getPeriodDigestHistory(first.id);
		expect(detail?.metadata).toMatchObject({
			date: "2026-07-31",
			status: "ready",
			title: "Digest 2026-07-31",
			provider: "openai",
		});
		expect(detail?.result).toMatchObject({
			markdown: "# Digest 2026-07-31\n\nSaved report.",
			cached: true,
		});
		expect(listPeriodDigestHistory()).toHaveLength(1);
	});

	it("prevents a stale worker from overwriting a reclaimed attempt", () => {
		const first = claimPeriodDigestDate("2026-07-30");
		if (!first.claimed) throw new Error("Expected the first claim to win");
		getNativeDb()
			.prepare("update period_digest_history set updated_at = ? where id = ?")
			.run("2020-01-01T00:00:00.000Z", first.id);
		const second = claimPeriodDigestDate("2026-07-30");
		if (!second.claimed)
			throw new Error("Expected a stale claim to be reclaimed");
		expect(second.claimToken).not.toBe(first.claimToken);
		expect(
			completePeriodDigestHistory(
				first.id,
				first.claimToken,
				resultForDate("2026-07-30"),
			),
		).toBe(false);
		expect(failPeriodDigestHistory(first.id, first.claimToken, "late")).toBe(
			false,
		);
		expect(
			completePeriodDigestHistory(
				second.id,
				second.claimToken,
				resultForDate("2026-07-30"),
			),
		).toBe(true);
	});

	it("never persists a provider key from a generation error", () => {
		const claim = claimPeriodDigestDate("2026-07-29");
		if (!claim.claimed) throw new Error("Expected claim");
		failPeriodDigestHistory(
			claim.id,
			claim.claimToken,
			new Error("provider rejected sk-example-private-value-9876"),
		);
		const [failed] = listPeriodDigestHistory();
		expect(failed?.error).toBe("provider rejected sk-exam...9876");
		expect(failed?.error).not.toContain("sk-example-private-value-9876");
	});

	it("uses local calendar boundaries across a daylight-saving transition", () => {
		process.env.TZ = "America/New_York";
		const springForward = localWindowForDateKey("2026-03-08");
		expect(
			new Date(springForward.until).getTime() -
				new Date(springForward.since).getTime(),
		).toBe(23 * 60 * 60_000);
	});
});
