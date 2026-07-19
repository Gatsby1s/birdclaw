import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { getNativeDb, getReadDb } from "./db";
import type { Database } from "./sqlite";
import type {
	XRemarkLiveSyncStatus,
	XRemarkPairingResult,
	XRemarkSyncStatus,
} from "./types";
import {
	getXRemarkSyncStatus,
	importXRemarkBackup,
	xRemarkBackupSchema,
} from "./xremark";

export const XREMARK_EXTENSION_ID = "imbbpjelfehedmikmbjglhpoiehpjjhl";
export const XREMARK_EXTENSION_ORIGIN = `chrome-extension://${XREMARK_EXTENSION_ID}`;
export const XREMARK_LIVE_ENDPOINT =
	"http://127.0.0.1:3001/api/integrations/xremark/snapshot";

const CONNECTED_WINDOW_MS = 10 * 60_000;

export const xRemarkLiveSnapshotSchema = xRemarkBackupSchema.extend({
	sourceId: z
		.string()
		.trim()
		.regex(/^[A-Za-z0-9_-]{8,128}$/),
	sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	capturedAt: z.number().finite().nonnegative(),
});

export type XRemarkLiveSnapshot = z.infer<typeof xRemarkLiveSnapshotSchema>;

type XRemarkLiveSyncRow = {
	token_hash: string | null;
	token_created_at: string | null;
	source_id: string | null;
	last_sequence: number;
	last_captured_at: number | null;
	last_snapshot_at: string | null;
	last_seen_at: string | null;
};

export class XRemarkLiveSyncError extends Error {
	readonly code: "source-conflict" | "stale-sequence";

	constructor(code: "source-conflict" | "stale-sequence", message: string) {
		super(message);
		this.name = "XRemarkLiveSyncError";
		this.code = code;
	}
}

function readLiveSyncRow(db: Database) {
	return db
		.prepare(
			`select token_hash, token_created_at, source_id, last_sequence,
			        last_captured_at,
			        last_snapshot_at, last_seen_at
			 from xremark_live_sync
			 where id = 1`,
		)
		.get() as XRemarkLiveSyncRow | undefined;
}

function hashToken(token: string) {
	return createHash("sha256").update(token, "utf8").digest();
}

export function getXRemarkLiveSyncStatus(
	db: Database = getReadDb({ seedDemoData: false }),
): XRemarkLiveSyncStatus {
	const row = readLiveSyncRow(db);
	const lastSeenAt = row?.last_seen_at ?? undefined;
	const lastSeenTime = lastSeenAt ? Date.parse(lastSeenAt) : Number.NaN;
	const connected =
		Boolean(row?.token_hash && lastSeenAt) &&
		Number.isFinite(lastSeenTime) &&
		Date.now() - lastSeenTime <= CONNECTED_WINDOW_MS;

	return {
		paired: Boolean(row?.token_hash),
		connected,
		extensionId: XREMARK_EXTENSION_ID,
		endpoint: XREMARK_LIVE_ENDPOINT,
		lastSequence: row?.last_sequence ?? 0,
		...(row?.token_created_at ? { tokenCreatedAt: row.token_created_at } : {}),
		...(row?.source_id ? { sourceId: row.source_id } : {}),
		...(row?.last_snapshot_at ? { lastSnapshotAt: row.last_snapshot_at } : {}),
		...(lastSeenAt ? { lastSeenAt } : {}),
	};
}

export function createXRemarkPairing(
	db: Database = getNativeDb({ seedDemoData: false }),
): XRemarkPairingResult {
	const token = randomBytes(32).toString("base64url");
	const tokenHash = hashToken(token).toString("hex");
	const createdAt = new Date().toISOString();
	db.prepare(
		`insert into xremark_live_sync (
			   id, token_hash, token_created_at, source_id, last_sequence,
			   last_captured_at,
			   last_snapshot_at, last_seen_at
			 ) values (1, ?, ?, null, 0, null, null, null)
		 on conflict(id) do update set
		   token_hash = excluded.token_hash,
			   token_created_at = excluded.token_created_at,
			   source_id = null,
			   last_sequence = 0,
			   last_captured_at = null,
			   last_snapshot_at = null,
		   last_seen_at = null`,
	).run(tokenHash, createdAt);

	return { ...getXRemarkLiveSyncStatus(db), token };
}

export function disconnectXRemarkLiveSync(
	db: Database = getNativeDb({ seedDemoData: false }),
) {
	db.prepare("delete from xremark_live_sync where id = 1").run();
	return getXRemarkLiveSyncStatus(db);
}

export function isValidXRemarkPairingToken(
	token: string,
	db: Database = getReadDb({ seedDemoData: false }),
) {
	const expectedHex = readLiveSyncRow(db)?.token_hash;
	if (!expectedHex || !/^[a-f0-9]{64}$/.test(expectedHex)) return false;
	const expected = Buffer.from(expectedHex, "hex");
	const actual = hashToken(token);
	return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function applyXRemarkLiveSnapshot(
	snapshot: XRemarkLiveSnapshot,
	db: Database = getNativeDb({ seedDemoData: false }),
): { live: XRemarkLiveSyncStatus; xRemark: XRemarkSyncStatus } {
	let result:
		| { live: XRemarkLiveSyncStatus; xRemark: XRemarkSyncStatus }
		| undefined;

	db.transaction(() => {
		const current = readLiveSyncRow(db);
		if (current?.source_id && current.source_id !== snapshot.sourceId) {
			throw new XRemarkLiveSyncError(
				"source-conflict",
				"This pairing already belongs to another X Remark data source.",
			);
		}
		if (
			current?.source_id === snapshot.sourceId &&
			snapshot.sequence < current.last_sequence
		) {
			throw new XRemarkLiveSyncError(
				"stale-sequence",
				"This X Remark snapshot is older than the latest live snapshot.",
			);
		}

		const now = new Date().toISOString();
		if (
			current?.source_id === snapshot.sourceId &&
			snapshot.sequence === current.last_sequence &&
			snapshot.capturedAt <= (current.last_captured_at ?? 0)
		) {
			db.prepare(
				"update xremark_live_sync set last_seen_at = ? where id = 1",
			).run(now);
			result = {
				live: getXRemarkLiveSyncStatus(db),
				xRemark: getXRemarkSyncStatus({}, db),
			};
			return;
		}

		const backup = xRemarkBackupSchema.parse({
			database: {
				...snapshot.database,
				backupID: `live:${snapshot.sourceId}:${String(snapshot.sequence)}`,
				backupTime: snapshot.capturedAt,
			},
			remarks: snapshot.remarks,
			tags: snapshot.tags,
			categories: snapshot.categories,
		});
		const xRemark = importXRemarkBackup(backup, db, { allowOlder: true });
		db.prepare(
			`update xremark_live_sync
			 set source_id = ?, last_sequence = ?, last_captured_at = ?,
			     last_snapshot_at = ?,
			     last_seen_at = ?
			 where id = 1`,
		).run(snapshot.sourceId, snapshot.sequence, snapshot.capturedAt, now, now);
		result = { live: getXRemarkLiveSyncStatus(db), xRemark };
	})();

	if (!result) throw new Error("X Remark live snapshot transaction failed");
	return result;
}
