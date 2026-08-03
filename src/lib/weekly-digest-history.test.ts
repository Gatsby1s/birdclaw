// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import type { PeriodDigestRunResult } from "./period-digest";
import {
	__test__,
	claimWeeklyDigest,
	completeWeeklyDigestHistory,
	CURRENT_WEEKLY_DIGEST_FORMAT_VERSION,
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
				formatVersion: CURRENT_WEEKLY_DIGEST_FORMAT_VERSION,
			},
			result: { cached: true, reasoningEffort: "high" },
		});
		expect(listWeeklyDigestHistory()).toHaveLength(1);
	});

	it("upgrades an old ready report without hiding or losing it on failure", () => {
		const first = claimWeeklyDigest("2026-07-20");
		if (!first.claimed) throw new Error("Expected the first claim to win");
		completeWeeklyDigestHistory(
			first.id,
			first.claimToken,
			resultForWeek("2026-07-20"),
		);
		const db = getNativeDb();
		db.prepare(
			`update weekly_digest_history
			 set format_version = 1, markdown = '# Legacy weekly report'
			 where id = ?`,
		).run(first.id);
		const legacyUpdatedAt = getWeeklyDigestHistory(first.id)?.metadata
			.updatedAt;

		const upgrade = claimWeeklyDigest("2026-07-20");
		expect(upgrade).toMatchObject({
			claimed: true,
			id: first.id,
			status: "ready",
			preserveReady: true,
		});
		expect(getWeeklyDigestHistory(first.id)?.result.markdown).toBe(
			"# Legacy weekly report",
		);
		expect(getWeeklyDigestHistory(first.id)?.metadata.updatedAt).toBe(
			legacyUpdatedAt,
		);
		if (!upgrade.claimed) throw new Error("Expected the upgrade claim to win");
		expect(
			failWeeklyDigestHistory(
				upgrade.id,
				upgrade.claimToken,
				new Error("temporary provider failure"),
				{ preserveReady: upgrade.preserveReady },
			),
		).toBe(true);
		expect(getWeeklyDigestHistory(first.id)).toMatchObject({
			metadata: {
				status: "ready",
				formatVersion: 1,
				updatedAt: legacyUpdatedAt,
			},
			result: { markdown: "# Legacy weekly report" },
		});

		const retry = claimWeeklyDigest("2026-07-20");
		if (!retry.claimed) throw new Error("Expected the upgrade retry to win");
		const richer = {
			...resultForWeek("2026-07-20"),
			markdown: "# Richer weekly report\n\nExpanded analysis.",
		};
		expect(
			completeWeeklyDigestHistory(retry.id, retry.claimToken, richer),
		).toBe(true);
		expect(getWeeklyDigestHistory(first.id)).toMatchObject({
			metadata: {
				status: "ready",
				formatVersion: CURRENT_WEEKLY_DIGEST_FORMAT_VERSION,
			},
			result: { markdown: richer.markdown },
		});
		expect(claimWeeklyDigest("2026-07-20")).toMatchObject({
			claimed: false,
			status: "ready",
		});
	});

	it("defers a failed ready upgrade until the next scheduler scan", async () => {
		const first = claimWeeklyDigest("2026-07-20");
		if (!first.claimed) throw new Error("Expected the first claim to win");
		completeWeeklyDigestHistory(
			first.id,
			first.claimToken,
			resultForWeek("2026-07-20"),
		);
		getNativeDb()
			.prepare(
				"update weekly_digest_history set format_version = 1 where id = ?",
			)
			.run(first.id);
		let runOptions:
			| {
					refresh?: boolean;
					reportProfile?: string;
					maxOutputTokens?: number;
			  }
			| undefined;

		const outcome = await __test__.archiveWeeklyDigestWithStream(
			"2026-07-20",
			{},
			async (options) => {
				const requested = options ?? {};
				runOptions = {
					refresh: requested.refresh,
					reportProfile: requested.reportProfile,
					maxOutputTokens: requested.maxOutputTokens,
				};
				throw new Error("provider remains unavailable");
			},
		);

		expect(outcome).toMatchObject({
			generated: false,
			id: first.id,
			status: "ready",
			upgradeFailed: true,
		});
		expect(runOptions).toMatchObject({
			refresh: false,
			reportProfile: "weekly-deep-dive",
			maxOutputTokens: 16_000,
		});
		expect(getWeeklyDigestHistory(first.id)).toMatchObject({
			metadata: { status: "ready", formatVersion: 1 },
		});
	});

	it("fences an upgrade worker after a current report replaces its claim", () => {
		const first = claimWeeklyDigest("2026-07-20");
		if (!first.claimed) throw new Error("Expected the first claim to win");
		completeWeeklyDigestHistory(
			first.id,
			first.claimToken,
			resultForWeek("2026-07-20"),
		);
		const db = getNativeDb();
		db.prepare(
			"update weekly_digest_history set format_version = 1 where id = ?",
		).run(first.id);
		const upgrade = claimWeeklyDigest("2026-07-20");
		if (!upgrade.claimed) throw new Error("Expected the upgrade claim to win");
		db.prepare(
			`update weekly_digest_history
			 set format_version = ?, claim_token = '', markdown = '# Remote v2'
			 where id = ?`,
		).run(CURRENT_WEEKLY_DIGEST_FORMAT_VERSION, first.id);

		expect(
			completeWeeklyDigestHistory(upgrade.id, upgrade.claimToken, {
				...resultForWeek("2026-07-20"),
				markdown: "# Stale worker v2",
			}),
		).toBe(false);
		expect(getWeeklyDigestHistory(first.id)?.result.markdown).toBe(
			"# Remote v2",
		);
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
