// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import {
	enqueueDatabaseWrite,
	resetDatabaseWriterForTests,
} from "./database-writer";
import {
	getDatabaseRuntimeMetrics,
	resetDatabaseRuntimeMetricsForTests,
} from "./database-metrics";
import { getNativeDb, resetDatabaseForTests } from "./db";

let tempDir: string | undefined;

afterEach(() => {
	resetDatabaseWriterForTests();
	resetDatabaseRuntimeMetricsForTests();
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

function setupDatabase() {
	tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-writer-"));
	process.env.BIRDCLAW_HOME = tempDir;
	const db = getNativeDb({ seedDemoData: false });
	db.exec(
		"create table writer_events (position integer primary key, name text)",
	);
}

describe("database writer", () => {
	it("serializes writes in enqueue order", async () => {
		setupDatabase();
		const order: string[] = [];

		await Promise.all([
			enqueueDatabaseWrite((db) => {
				order.push("first");
				db.prepare(
					"insert into writer_events (position, name) values (1, 'first')",
				).run();
			}),
			enqueueDatabaseWrite((db) => {
				order.push("second");
				db.prepare(
					"insert into writer_events (position, name) values (2, 'second')",
				).run();
			}),
		]);

		expect(order).toEqual(["first", "second"]);
		expect(
			getNativeDb({ seedDemoData: false })
				.prepare("select name from writer_events order by position")
				.all(),
		).toEqual([{ name: "first" }, { name: "second" }]);
		expect(
			getNativeDb({ seedDemoData: false })
				.prepare("select count(*) as count from accounts")
				.get(),
		).toEqual({ count: 0 });
	});

	it("rolls back failed writes and keeps the queue usable", async () => {
		setupDatabase();

		await expect(
			enqueueDatabaseWrite((db) => {
				db.prepare(
					"insert into writer_events (position, name) values (1, 'rolled back')",
				).run();
				throw new Error("write failed");
			}),
		).rejects.toThrow("write failed");
		await enqueueDatabaseWrite((db) => {
			db.prepare(
				"insert into writer_events (position, name) values (2, 'committed')",
			).run();
		});

		expect(
			getNativeDb({ seedDemoData: false })
				.prepare("select name from writer_events order by position")
				.all(),
		).toEqual([{ name: "committed" }]);
		expect(getDatabaseRuntimeMetrics().writer).toMatchObject({
			completed: 2,
			failed: 1,
			queued: 0,
		});
	});
});
