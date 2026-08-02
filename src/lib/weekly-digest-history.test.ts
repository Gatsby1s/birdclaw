// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import type { PeriodDigestRunResult } from "./period-digest";
import {
	claimWeeklyDigest,
	completeWeeklyDigestHistory,
	failWeeklyDigestHistory,
	getWeeklyDigestHistory,
	listWeeklyDigestHistory,
	localWeekStartKey,
	localWindowForWeekStart,
	previousCompletedWeekStartKey,
} from "./weekly-digest-history";

let temporaryHome = "";
let originalTimezone: string | undefined;

function resultForWeek(weekStart: string): PeriodDigestRunResult {
	const window = localWindowForWeekStart(weekStart);
	return {
		context: {
			window: { label: weekStart, since: window.since, until: window.until },
			includeDms: false,
			counts: {
				home: 40,
				mentions: 2,
				authored: 0,
				likes: 0,
				bookmarks: 0,
				dms: 0,
				links: 8,
			},
			tweets: [],
			dms: [],
			links: [],
			hash: `hash-${weekStart}`,
		},
		digest: {
			title: `Weekly digest ${weekStart}`,
			summary: "Saved once and restored without model usage.",
			keyTopics: [],
			notableLinks: [],
			people: [],
			actionItems: [],
			sourceTweetIds: [],
		},
		markdown: `# Weekly digest ${weekStart}\n\nSaved report.`,
		provider: "openai",
		model: "gpt-5.5",
		reasoningEffort: "high",
		serviceTier: "priority",
		cached: false,
		updatedAt: new Date().toISOString(),
	};
}

beforeEach(() => {
	temporaryHome = mkdtempSync(
		path.join(os.tmpdir(), "birdclaw-weekly-history-"),
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

describe("weekly digest history", () => {
	it("uses closed local Monday-to-Monday windows", () => {
		process.env.TZ = "Asia/Shanghai";
		expect(localWeekStartKey(new Date("2026-08-02T12:00:00+08:00"))).toBe(
			"2026-07-27",
		);
		expect(
			previousCompletedWeekStartKey(new Date("2026-08-02T12:00:00+08:00")),
		).toBe("2026-07-20");
		expect(localWindowForWeekStart("2026-07-20")).toMatchObject({
			since: "2026-07-19T16:00:00.000Z",
			until: "2026-07-26T16:00:00.000Z",
			endDate: "2026-07-26",
		});
		expect(() => localWindowForWeekStart("2026-07-21")).toThrow("local Monday");
	});

	it("pins the production container to the Shanghai week boundary", () => {
		const boundary = new Date("2026-08-02T16:30:00.000Z");
		process.env.TZ = "UTC";
		expect(previousCompletedWeekStartKey(boundary)).toBe("2026-07-20");
		process.env.TZ = "Asia/Shanghai";
		expect(previousCompletedWeekStartKey(boundary)).toBe("2026-07-27");
		expect(readFileSync("Dockerfile", "utf8")).toContain(
			"ENV TZ=Asia/Shanghai",
		);
	});

	it("preserves DST-aware calendar weeks", () => {
		process.env.TZ = "America/New_York";
		const window = localWindowForWeekStart("2026-03-02");
		expect(
			new Date(window.until).getTime() - new Date(window.since).getTime(),
		).toBe(167 * 60 * 60_000);
	});

	it("claims one generator per week and restores with zero-token cache state", () => {
		const first = claimWeeklyDigest("2026-07-20");
		expect(first.claimed).toBe(true);
		expect(claimWeeklyDigest("2026-07-20")).toMatchObject({
			claimed: false,
			id: first.id,
			status: "pending",
		});
		if (!first.claimed) throw new Error("Expected the first claim to win");
		expect(
			completeWeeklyDigestHistory(
				first.id,
				first.claimToken,
				resultForWeek("2026-07-20"),
			),
		).toBe(true);
		expect(getWeeklyDigestHistory(first.id)).toMatchObject({
			metadata: {
				kind: "weekly",
				date: "2026-07-20",
				endDate: "2026-07-26",
				status: "ready",
			},
			result: { cached: true, reasoningEffort: "high" },
		});
		expect(listWeeklyDigestHistory()).toHaveLength(1);
	});

	it("fences stale workers and redacts provider secrets", () => {
		const first = claimWeeklyDigest("2026-07-13");
		if (!first.claimed) throw new Error("Expected the first claim to win");
		getNativeDb()
			.prepare("update weekly_digest_history set updated_at = ? where id = ?")
			.run("2020-01-01T00:00:00.000Z", first.id);
		const second = claimWeeklyDigest("2026-07-13");
		if (!second.claimed)
			throw new Error("Expected the stale claim to be reclaimed");
		expect(
			completeWeeklyDigestHistory(
				first.id,
				first.claimToken,
				resultForWeek("2026-07-13"),
			),
		).toBe(false);
		failWeeklyDigestHistory(
			second.id,
			second.claimToken,
			new Error("provider rejected sk-example-private-value-9876"),
		);
		expect(listWeeklyDigestHistory()[0]?.error).toBe(
			"provider rejected sk-exam...9876",
		);
	});
});
