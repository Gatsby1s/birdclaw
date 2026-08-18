// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import {
	__test__,
	nextIntradayBoundaryDelay,
	startupIntradaySlots,
} from "./intraday-digest-scheduler";

let temporaryHome = "";
let originalTimezone: string | undefined;

beforeEach(() => {
	temporaryHome = mkdtempSync(
		path.join(os.tmpdir(), "birdclaw-intraday-scheduler-"),
	);
	originalTimezone = process.env.TZ;
	process.env.TZ = "Asia/Shanghai";
	process.env.BIRDCLAW_HOME = temporaryHome;
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
});

afterEach(() => {
	vi.useRealTimers();
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	if (originalTimezone === undefined) delete process.env.TZ;
	else process.env.TZ = originalTimezone;
	rmSync(temporaryHome, { recursive: true, force: true });
});

function insertSlot(slotKey: string, status: "ready" | "failed" = "ready") {
	const timestamp = "2026-08-18T00:00:00.000Z";
	getNativeDb({ seedDemoData: false })
		.prepare(
			`insert into period_digest_history (
			 id, digest_date, timezone, status, started_at, finished_at,
			 created_at, updated_at
			) values (?, ?, 'Asia/Shanghai', ?, ?, ?, ?, ?)`,
		)
		.run(
			`history-${slotKey}`,
			slotKey,
			status,
			timestamp,
			timestamp,
			timestamp,
			timestamp,
		);
}

describe("intraday digest scheduler", () => {
	it("starts with only the latest completed slot on a fresh archive", () => {
		expect(startupIntradaySlots(new Date("2026-08-18T21:43:00+08:00"))).toEqual(
			["2026-08-18@16"],
		);
	});

	it("catches up completed slots after the newest saved window", () => {
		insertSlot("2026-08-17@24");
		expect(startupIntradaySlots(new Date("2026-08-18T21:43:00+08:00"))).toEqual(
			["2026-08-18@08", "2026-08-18@16"],
		);
	});

	it("caps catch-up at the latest 24 hours after a long outage", () => {
		insertSlot("2026-08-10@16");
		expect(startupIntradaySlots(new Date("2026-08-18T21:43:00+08:00"))).toEqual(
			["2026-08-17@24", "2026-08-18@08", "2026-08-18@16"],
		);
	});

	it("requeues failed windows without regenerating ready windows", () => {
		insertSlot("2026-08-18@08", "failed");
		insertSlot("2026-08-18@16");
		expect(startupIntradaySlots(new Date("2026-08-18T21:43:00+08:00"))).toEqual(
			["2026-08-18@08"],
		);
	});

	it("recomputes the delay to the next local 8-hour boundary", () => {
		expect(
			nextIntradayBoundaryDelay(new Date("2026-08-18T07:30:00+08:00")),
		).toBe(30 * 60_000);
		expect(
			nextIntradayBoundaryDelay(new Date("2026-08-18T15:30:00+08:00")),
		).toBe(30 * 60_000);
		expect(
			nextIntradayBoundaryDelay(new Date("2026-08-18T23:30:00+08:00")),
		).toBe(30 * 60_000);
	});

	it("keeps an independent retry timer for every failed slot", () => {
		vi.useFakeTimers();
		const scheduler = new __test__.IntradayDigestScheduler({
			archive: vi.fn(),
		});
		const internal = scheduler as unknown as {
			retryTimers: Map<string, ReturnType<typeof setTimeout>>;
			scheduleRetry: (slotKey: string) => void;
		};
		internal.scheduleRetry("2026-08-18@08");
		internal.scheduleRetry("2026-08-18@16");
		expect([...internal.retryTimers.keys()]).toEqual([
			"2026-08-18@08",
			"2026-08-18@16",
		]);
		scheduler.stop();
	});
});
