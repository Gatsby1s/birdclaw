// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import { createTwillotCompanionPairing } from "./twillot-companion";
import {
	__test__,
	getTwillotFollowSyncStatus,
	runTwillotFollowSyncOnce,
	startTwillotFollowScheduler,
	stopTwillotFollowScheduler,
} from "./twillot-follow-scheduler";

const tempDirs: string[] = [];

afterEach(() => {
	stopTwillotFollowScheduler();
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	delete process.env.BIRDCLAW_TWILLOT_FOLLOW_SYNC_ENABLED;
	delete process.env.BIRDCLAW_TWILLOT_FOLLOW_SYNC_INTERVAL_MINUTES;
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function database() {
	const root = mkdtempSync(path.join(os.tmpdir(), "birdclaw-twillot-follow-"));
	tempDirs.push(root);
	process.env.BIRDCLAW_HOME = root;
	resetBirdclawPathsForTests();
	return getNativeDb({ seedDemoData: false });
}

describe("Twillot following scheduler", () => {
	it("does not call X until a companion is explicitly paired", async () => {
		const db = database();
		const sync = vi.fn();
		expect(await runTwillotFollowSyncOnce({ db, sync })).toEqual({
			ok: false,
			skipped: "not-paired",
		});
		expect(sync).not.toHaveBeenCalled();
	});

	it("refreshes the complete following snapshot and records success", async () => {
		const db = database();
		createTwillotCompanionPairing(db);
		const sync = vi.fn().mockResolvedValue({
			ok: true,
			dryRun: false,
			partial: false,
			status: "complete",
		});
		const result = await runTwillotFollowSyncOnce({
			db,
			sync,
			now: new Date("2026-08-10T01:00:00.000Z"),
		});
		expect(result.ok).toBe(true);
		expect(sync).toHaveBeenCalledWith({
			direction: "following",
			mode: "auto",
			yes: true,
			refresh: true,
			allowPartial: false,
		});
		expect(getTwillotFollowSyncStatus(db)).toMatchObject({
			enabled: true,
			running: false,
			lastStartedAt: "2026-08-10T01:00:00.000Z",
			lastError: null,
		});
	});

	it("clamps interval configuration and honors the explicit disable switch", () => {
		const db = database();
		createTwillotCompanionPairing(db);
		process.env.BIRDCLAW_TWILLOT_FOLLOW_SYNC_INTERVAL_MINUTES = "bad";
		expect(__test__.intervalMs()).toBe(6 * 60 * 60_000);
		process.env.BIRDCLAW_TWILLOT_FOLLOW_SYNC_INTERVAL_MINUTES = "1";
		expect(__test__.intervalMs()).toBe(60 * 60_000);
		process.env.BIRDCLAW_TWILLOT_FOLLOW_SYNC_INTERVAL_MINUTES = "120";
		expect(__test__.intervalMs()).toBe(120 * 60_000);
		process.env.BIRDCLAW_TWILLOT_FOLLOW_SYNC_ENABLED = "0";
		expect(getTwillotFollowSyncStatus(db)).toMatchObject({
			enabled: false,
			intervalMinutes: 120,
		});
		delete process.env.BIRDCLAW_TWILLOT_FOLLOW_SYNC_INTERVAL_MINUTES;
	});

	it("rejects overlapping runs and records partial and thrown failures", async () => {
		const db = database();
		createTwillotCompanionPairing(db);
		let release: ((value: { ok: true; partial: false }) => void) | undefined;
		const pending = vi.fn(
			() =>
				new Promise<{ ok: true; partial: false }>((resolve) => {
					release = resolve;
				}),
		);
		const first = runTwillotFollowSyncOnce({ db, sync: pending as never });
		await vi.waitFor(() => expect(pending).toHaveBeenCalledOnce());
		expect(
			await runTwillotFollowSyncOnce({ db, sync: pending as never }),
		).toEqual({
			ok: false,
			skipped: "already-running",
		});
		release?.({ ok: true, partial: false });
		expect((await first).ok).toBe(true);

		const partial = await runTwillotFollowSyncOnce({
			db,
			sync: vi.fn().mockResolvedValue({ ok: true, partial: true }),
		});
		expect(partial).toMatchObject({
			ok: false,
			error: "Automatic following refresh returned an incomplete snapshot",
		});
		const thrown = await runTwillotFollowSyncOnce({
			db,
			sync: vi.fn().mockRejectedValue("offline"),
		});
		expect(thrown).toEqual({ ok: false, error: "offline" });
	});

	it("installs only one scheduler pair and stops both timers", () => {
		vi.useFakeTimers();
		try {
			startTwillotFollowScheduler();
			startTwillotFollowScheduler();
			expect(vi.getTimerCount()).toBe(2);
			stopTwillotFollowScheduler();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});
