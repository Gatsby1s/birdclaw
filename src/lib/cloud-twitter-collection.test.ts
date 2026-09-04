// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import { importTwillotFollowingSnapshot } from "./follow-graph";
import {
	evaluatePreviousTwillotFallback,
	findCloudFollowingTarget,
	listCloudFollowingTargets,
	mergeCloudCollectionHandles,
	queueTwillotFallback,
} from "./cloud-twitter-collection";

let tempRoot = "";

function setup() {
	tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-cloud-targets-"));
	process.env.BIRDCLAW_HOME = tempRoot;
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
	const db = getNativeDb({ seedDemoData: false });
	db.prepare(
		`insert into accounts (
		   id, name, handle, external_user_id, transport, is_default, created_at
		 ) values ('acct', 'Owner', 'owner', '1', 'xurl', 1, ?)`,
	).run("2026-09-04T00:00:00.000Z");
	importTwillotFollowingSnapshot(db, {
		users: [
			{ id: "42", username: "Alice", name: "Alice" },
			{ id: "43", username: "bob", name: "Bob" },
		],
		pageCount: 1,
		complete: true,
	});
	return db;
}

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
	tempRoot = "";
});

describe("cloud Twitter collection targets", () => {
	it("merges every current Twillot following account with configured targets", () => {
		const db = setup();
		expect(listCloudFollowingTargets(db).map((item) => item.handle)).toEqual([
			"Alice",
			"bob",
		]);
		expect(mergeCloudCollectionHandles(db, ["@alice", "carol"], true)).toEqual([
			"Alice",
			"carol",
			"bob",
		]);
	});

	it("queues Twillot after Fx failure and recognizes completion or timeout", () => {
		const db = setup();
		const target = findCloudFollowingTarget(db, "alice")!;
		const failedAt = "2026-09-04T01:00:00.000Z";
		const job = queueTwillotFallback(db, {
			target,
			now: new Date(failedAt),
		});
		expect(job).toMatchObject({ state: "queued", handle: "Alice" });
		expect(
			evaluatePreviousTwillotFallback(db, {
				target,
				lastFxFailureAt: failedAt,
				timeoutMs: 30 * 60_000,
				now: new Date("2026-09-04T01:10:00.000Z"),
			}),
		).toBe("pending");
		expect(
			evaluatePreviousTwillotFallback(db, {
				target,
				lastFxFailureAt: failedAt,
				timeoutMs: 30 * 60_000,
				now: new Date("2026-09-04T01:31:00.000Z"),
			}),
		).toBe("failed");

		db.prepare(
			`update twillot_history_jobs
			 set state = 'completed', capture_status = 'caught_up_unverified',
			     completed_at = ?, updated_at = ? where id = ?`,
		).run("2026-09-04T01:05:00.000Z", "2026-09-04T01:05:00.000Z", job!.id);
		expect(
			evaluatePreviousTwillotFallback(db, {
				target,
				lastFxFailureAt: failedAt,
				timeoutMs: 30 * 60_000,
				now: new Date("2026-09-04T01:10:00.000Z"),
			}),
		).toBe("completed");
	});
});
