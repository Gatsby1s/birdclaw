// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import type { TimelineItem } from "./types";
import {
	enrichTimelineItemsWithXRemark,
	getXRemarkSyncStatus,
	importXRemarkBackup,
	xRemarkBackupSchema,
} from "./xremark";

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
	const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-xremark-"));
	tempDirs.push(tempDir);
	process.env.BIRDCLAW_HOME = tempDir;
	resetBirdclawPathsForTests();
	return getNativeDb({ seedDemoData: false });
}

function backup(
	remarks: Array<Record<string, unknown>>,
	backupId = "backup_1",
) {
	return xRemarkBackupSchema.parse({
		database: {
			name: "xRemark",
			version: 1,
			backupID: backupId,
			backupTime: 1_752_499_800_000,
		},
		remarks,
		tags: [
			{ id: 1, name: "Founder" },
			{ id: 2, name: "AI" },
		],
		categories: [{ id: 7, name: "People" }],
	});
}

function timelineItem(profile: { id: string; handle: string }): TimelineItem {
	return {
		id: `tweet_${profile.id}`,
		accountId: "account_1",
		accountHandle: "owner",
		kind: "home",
		text: "Hello",
		createdAt: "2026-07-19T00:00:00.000Z",
		isReplied: false,
		likeCount: 0,
		mediaCount: 0,
		bookmarked: false,
		liked: false,
		author: {
			...profile,
			displayName: profile.handle,
			bio: "",
			followersCount: 0,
			avatarHue: 1,
			createdAt: "2026-07-19T00:00:00.000Z",
		},
		entities: {},
		media: [],
	};
}

describe("X Remark backup import", () => {
	it("matches the stable X identifier before falling back to a valid handle", () => {
		const db = createDatabase();
		db.exec(`
			insert into profiles (
				id, handle, display_name, bio, followers_count, avatar_hue, created_at
			) values
				('profile_user_42', 'renamed_handle', 'ID match', '', 0, 1, '2026-07-19T00:00:00.000Z'),
				('profile_other', 'handle_match', 'Handle match', '', 0, 2, '2026-07-19T00:00:00.000Z'),
				('profile_reused_handle', 'old_handle', 'Reused handle', '', 0, 3, '2026-07-19T00:00:00.000Z')
		`);

		const status = importXRemarkBackup(
			backup([
				{
					identifier: 42,
					additionalName: "old_handle",
					givenName: "Ada",
					remark: "Met at WWDC",
					description: "Interested in local-first tools",
					tags: [1, 2],
					category: 7,
					updateTime: 1_752_499_700_000,
				},
				{
					identifier: 99,
					additionalName: "@handle_match",
					remark: "Handle fallback",
				},
			]),
			db,
		);

		expect(status).toMatchObject({
			imported: true,
			annotationCount: 2,
			matchedProfileCount: 2,
			backupId: "backup_1",
		});
		const enriched = enrichTimelineItemsWithXRemark(
			[
				timelineItem({ id: "profile_user_42", handle: "renamed_handle" }),
				timelineItem({ id: "profile_other", handle: "handle_match" }),
				timelineItem({ id: "profile_reused_handle", handle: "old_handle" }),
			],
			db,
		);
		expect(enriched[0]?.author.xRemark).toMatchObject({
			identifier: "42",
			remark: "Met at WWDC",
			tags: ["Founder", "AI"],
			category: "People",
		});
		expect(enriched[1]?.author.xRemark?.remark).toBe("Handle fallback");
		expect(enriched[2]?.author.xRemark).toBeUndefined();
		expect(
			getXRemarkSyncStatus({ handle: "renamed_handle" }, db).annotation,
		).toMatchObject({ identifier: "42", remark: "Met at WWDC" });
		expect(
			getXRemarkSyncStatus({ handle: "old_handle" }, db).annotation,
		).toBeNull();
	});

	it("atomically replaces the previous snapshot", () => {
		const db = createDatabase();
		importXRemarkBackup(
			backup([{ identifier: "1", additionalName: "first", remark: "Old" }]),
			db,
		);
		const status = importXRemarkBackup(
			backup(
				[{ identifier: "2", additionalName: "second", remark: "New" }],
				"backup_2",
			),
			db,
		);

		expect(status).toMatchObject({ annotationCount: 1, backupId: "backup_2" });
		expect(getXRemarkSyncStatus({ handle: "first" }, db).annotation).toBeNull();
		expect(
			getXRemarkSyncStatus({ handle: "second" }, db).annotation,
		).toMatchObject({ remark: "New" });
	});

	it("rejects an older snapshot without replacing current notes", () => {
		const db = createDatabase();
		importXRemarkBackup(
			backup([{ identifier: "1", additionalName: "first", remark: "Current" }]),
			db,
		);
		const older = backup(
			[{ identifier: "2", additionalName: "second", remark: "Older" }],
			"backup_older",
		);
		older.database.backupTime -= 1;

		expect(() => importXRemarkBackup(older, db)).toThrow(/older/);
		expect(
			getXRemarkSyncStatus({ handle: "first" }, db).annotation,
		).toMatchObject({ remark: "Current" });
		expect(
			getXRemarkSyncStatus({ handle: "second" }, db).annotation,
		).toBeNull();
	});

	it("rejects unrelated JSON instead of mutating the database", () => {
		const db = createDatabase();
		expect(() =>
			xRemarkBackupSchema.parse({
				database: {
					name: "not-xremark",
					version: 1,
					backupID: "wrong",
					backupTime: 1,
				},
				remarks: [],
			}),
		).toThrow(/xRemark|Invalid input/);
		expect(getXRemarkSyncStatus({}, db).imported).toBe(false);
	});
});
