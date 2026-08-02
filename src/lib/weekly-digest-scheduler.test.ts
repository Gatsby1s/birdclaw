// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import { __test__, startupDigestWeeks } from "./weekly-digest-scheduler";

let temporaryHome = "";

beforeEach(() => {
	temporaryHome = mkdtempSync(
		path.join(os.tmpdir(), "birdclaw-weekly-scheduler-"),
	);
	process.env.BIRDCLAW_HOME = temporaryHome;
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
});

afterEach(() => {
	vi.useRealTimers();
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	rmSync(temporaryHome, { recursive: true, force: true });
});

function insertReadyWeek(weekStart: string) {
	const end = new Date(`${weekStart}T12:00:00`);
	end.setDate(end.getDate() + 6);
	const endDate = [
		String(end.getFullYear()).padStart(4, "0"),
		String(end.getMonth() + 1).padStart(2, "0"),
		String(end.getDate()).padStart(2, "0"),
	].join("-");
	const timestamp = `${weekStart}T00:00:00.000Z`;
	getNativeDb({ seedDemoData: false })
		.prepare(
			`insert into weekly_digest_history (
			 id, week_start, week_end, timezone, status, started_at, finished_at,
			 created_at, updated_at
			) values (?, ?, ?, 'Asia/Shanghai', 'ready', ?, ?, ?, ?)`,
		)
		.run(
			`history-${weekStart}`,
			weekStart,
			endDate,
			timestamp,
			timestamp,
			timestamp,
			timestamp,
		);
}

describe("weekly digest scheduler", () => {
	it("starts with the previous completed natural week only", () => {
		expect(startupDigestWeeks(new Date(2026, 7, 2, 8))).toEqual(["2026-07-20"]);
		expect(startupDigestWeeks(new Date(2026, 7, 3, 8))).toEqual(["2026-07-27"]);
	});

	it("fills weekly gaps without including the current open week", () => {
		insertReadyWeek("2026-07-06");
		insertReadyWeek("2026-07-20");
		expect(startupDigestWeeks(new Date(2026, 7, 2, 8))).toEqual(["2026-07-13"]);
	});

	it("caps historical catch-up to twelve completed weeks", () => {
		insertReadyWeek("2025-01-06");
		const missing = startupDigestWeeks(new Date(2026, 7, 3, 8));
		expect(missing).toHaveLength(12);
		expect(missing[0]).toBe("2026-05-11");
		expect(missing.at(-1)).toBe("2026-07-27");
	});

	it("keeps independent retry timers for failed weeks", () => {
		vi.useFakeTimers();
		const scheduler = new __test__.WeeklyDigestScheduler({
			archive: vi.fn(),
			ensurePdf: vi.fn(),
		});
		const internal = scheduler as unknown as {
			retryTimers: Map<string, ReturnType<typeof setTimeout>>;
			scheduleRetry: (weekStart: string) => void;
		};
		internal.scheduleRetry("2026-07-13");
		internal.scheduleRetry("2026-07-20");
		expect([...internal.retryTimers.keys()]).toEqual([
			"2026-07-13",
			"2026-07-20",
		]);
		scheduler.stop();
	});
});
