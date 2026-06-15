import { Effect } from "effect";
import { getNativeDb } from "./db";
import type { Database } from "./sqlite";
import {
	recordDatabaseWriteCompleted,
	recordDatabaseWriteQueued,
	recordDatabaseWriteStarted,
} from "./database-metrics";

let writeTail: Promise<void> = Promise.resolve();

export function enqueueDatabaseWrite<T>(
	write: (db: Database) => T,
): Promise<T> {
	const queuedAt = performance.now();
	recordDatabaseWriteQueued();
	const pending = writeTail.then(() => {
		recordDatabaseWriteStarted(performance.now() - queuedAt);
		try {
			const db = getNativeDb({ seedDemoData: false });
			const result = db.transaction(() => write(db))();
			recordDatabaseWriteCompleted(false);
			return result;
		} catch (error) {
			recordDatabaseWriteCompleted(true);
			throw error;
		}
	});
	writeTail = pending.then(
		() => undefined,
		() => undefined,
	);
	return pending;
}

export function databaseWriteEffect<T>(write: (db: Database) => T) {
	return Effect.tryPromise({
		try: () => enqueueDatabaseWrite(write),
		catch: (error) =>
			error instanceof Error ? error : new Error(String(error)),
	});
}

export async function drainDatabaseWrites() {
	await writeTail;
}

export function resetDatabaseWriterForTests() {
	writeTail = Promise.resolve();
}
