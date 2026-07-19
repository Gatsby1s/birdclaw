// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import {
	applyXRemarkLiveSnapshot,
	createXRemarkPairing,
	disconnectXRemarkLiveSync,
	getXRemarkLiveSyncStatus,
	isValidXRemarkPairingToken,
	XRemarkLiveSyncError,
	xRemarkLiveSnapshotSchema,
} from "./xremark-live";
import { getXRemarkSyncStatus } from "./xremark";

const tempDirs: string[] = [];

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createDatabase() {
	const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-xremark-live-"));
	tempDirs.push(tempDir);
	process.env.BIRDCLAW_HOME = tempDir;
	resetBirdclawPathsForTests();
	return getNativeDb({ seedDemoData: false });
}

function snapshot({
	sequence,
	sourceId = "source_test_1",
	remarks = [],
}: {
	sequence: number;
	sourceId?: string;
	remarks?: Array<Record<string, unknown>>;
}) {
	return xRemarkLiveSnapshotSchema.parse({
		sourceId,
		sequence,
		capturedAt: 1_752_499_800_000 + sequence,
		database: {
			name: "xRemark",
			version: 1,
			backupID: `source_test_1_${String(sequence)}`,
			backupTime: 1_752_499_800_000 + sequence,
		},
		remarks,
		tags: [],
		categories: [],
	});
}

describe("X Remark live sync", () => {
	it("creates a hashed pairing token and can disconnect without deleting notes", () => {
		const db = createDatabase();
		const pairing = createXRemarkPairing(db);
		const stored = db
			.prepare("select token_hash from xremark_live_sync where id = 1")
			.get() as { token_hash: string };

		expect(pairing).toMatchObject({ paired: true, connected: false });
		expect(pairing.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
		expect(stored.token_hash).not.toBe(pairing.token);
		expect(stored.token_hash).toMatch(/^[a-f0-9]{64}$/);
		expect(isValidXRemarkPairingToken(pairing.token, db)).toBe(true);
		expect(isValidXRemarkPairingToken(`${pairing.token}x`, db)).toBe(false);

		applyXRemarkLiveSnapshot(
			snapshot({
				sequence: 1,
				remarks: [
					{ identifier: "42", additionalName: "ada", remark: "Investor" },
				],
			}),
			db,
		);
		expect(disconnectXRemarkLiveSync(db).paired).toBe(false);
		expect(
			getXRemarkSyncStatus({ identifier: "42" }, db).annotation,
		).toMatchObject({ remark: "Investor" });
	});

	it("atomically applies ordered snapshots, deletions, and idempotent heartbeats", () => {
		const db = createDatabase();
		createXRemarkPairing(db);
		const first = applyXRemarkLiveSnapshot(
			snapshot({
				sequence: 1,
				remarks: [{ identifier: "42", additionalName: "ada", remark: "First" }],
			}),
			db,
		);
		expect(first.live).toMatchObject({
			connected: true,
			lastSequence: 1,
			sourceId: "source_test_1",
		});
		expect(first.xRemark.annotationCount).toBe(1);

		const heartbeat = applyXRemarkLiveSnapshot(
			snapshot({
				sequence: 1,
				remarks: [
					{
						identifier: "42",
						additionalName: "ada",
						remark: "Ignored replay",
					},
				],
			}),
			db,
		);
		expect(heartbeat.live.lastSequence).toBe(1);
		expect(
			getXRemarkSyncStatus({ identifier: "42" }, db).annotation,
		).toMatchObject({ remark: "First" });
		const corrected = snapshot({
			sequence: 1,
			remarks: [
				{ identifier: "42", additionalName: "ada", remark: "Corrected" },
			],
		});
		corrected.capturedAt += 1;
		const correction = applyXRemarkLiveSnapshot(corrected, db);
		expect(correction.live.lastSequence).toBe(1);
		expect(
			getXRemarkSyncStatus({ identifier: "42" }, db).annotation,
		).toMatchObject({ remark: "Corrected" });

		const deleted = applyXRemarkLiveSnapshot(
			snapshot({ sequence: 2, remarks: [] }),
			db,
		);
		expect(deleted.xRemark.annotationCount).toBe(0);
		expect(
			getXRemarkSyncStatus({ identifier: "42" }, db).annotation,
		).toBeNull();
	});

	it("rejects stale sequences and a second data source", () => {
		const db = createDatabase();
		createXRemarkPairing(db);
		applyXRemarkLiveSnapshot(snapshot({ sequence: 2 }), db);

		expect(() =>
			applyXRemarkLiveSnapshot(snapshot({ sequence: 1 }), db),
		).toThrow(XRemarkLiveSyncError);
		expect(() =>
			applyXRemarkLiveSnapshot(
				snapshot({ sequence: 3, sourceId: "source_other_2" }),
				db,
			),
		).toThrow(/another X Remark data source/);
		expect(getXRemarkLiveSyncStatus(db).lastSequence).toBe(2);
	});
});
