import { createHash } from "node:crypto";
import { getNativeDb, getReadDb } from "./db";
import type { Database } from "./sqlite";
import type { ProfilePriorityStatus } from "./types";

export interface ProfilePriorityRow {
	priorityKey: string;
	identifier: string | null;
	additionalName: string;
	isSpecialFollow: number;
	updatedAt: string;
}

export interface ProfilePrioritySnapshot {
	fingerprint: string;
	rows: ProfilePriorityRow[];
	priorityProfileIds: string[];
	priorityHandleOnlyHandles: string[];
	isSpecialFollow: (profile: {
		handle?: string | null;
		identifier?: string | null;
	}) => boolean;
}

function normalizedPriorityRow(row: ProfilePriorityRow): ProfilePriorityRow {
	const additionalName = normalizeHandle(row.additionalName);
	const identifier = normalizeProfilePriorityIdentifier(row.identifier);
	const expectedKey = identifier
		? `id:${identifier}`
		: `handle:${additionalName}`;
	if (
		!additionalName ||
		row.priorityKey !== expectedKey ||
		(row.isSpecialFollow !== 0 && row.isSpecialFollow !== 1) ||
		!Number.isFinite(Date.parse(row.updatedAt)) ||
		new Date(row.updatedAt).toISOString() !== row.updatedAt
	) {
		throw new Error("Invalid profile priority row.");
	}
	return {
		...row,
		identifier: identifier || null,
		additionalName,
	};
}

function normalizeHandle(value: string | null | undefined) {
	const handle = value?.trim().replace(/^@/, "").toLowerCase() ?? "";
	return /^[a-z0-9_]{1,15}$/.test(handle) ? handle : "";
}

export function normalizeProfilePriorityIdentifier(
	value: string | null | undefined,
) {
	const identifier = value?.trim() ?? "";
	if (!identifier || identifier.startsWith("profile_handle_")) return "";
	if (identifier.startsWith("profile_user_")) {
		return identifier.slice("profile_user_".length).trim();
	}
	return identifier;
}

function rowToStatus(row: ProfilePriorityRow | undefined, handle: string) {
	return {
		handle,
		...(row?.identifier ? { identifier: row.identifier } : {}),
		specialFollow: row?.isSpecialFollow === 1,
		...(row?.updatedAt ? { updatedAt: row.updatedAt } : {}),
	} satisfies ProfilePriorityStatus;
}

function getRowByKey(db: Database, priorityKey: string) {
	return db
		.prepare(
			`select
			   priority_key as priorityKey,
			   identifier,
			   additional_name as additionalName,
			   is_special_follow as isSpecialFollow,
			   updated_at as updatedAt
			 from birdclaw_profile_priorities
			 where priority_key = ?`,
		)
		.get(priorityKey) as ProfilePriorityRow | undefined;
}

export function getProfilePriority(
	lookup: { handle: string; identifier?: string },
	db: Database = getReadDb({ seedDemoData: false }),
) {
	const handle = normalizeHandle(lookup.handle);
	if (!handle) throw new Error("A valid X handle is required.");
	const identifier = normalizeProfilePriorityIdentifier(lookup.identifier);
	const priorityKey = identifier ? `id:${identifier}` : `handle:${handle}`;
	return rowToStatus(getRowByKey(db, priorityKey), handle);
}

function upsertPriorityRow(db: Database, row: ProfilePriorityRow) {
	db.prepare(
		`insert into birdclaw_profile_priorities (
		   priority_key, identifier, additional_name, is_special_follow, updated_at
		 ) values (?, ?, ?, ?, ?)
		 on conflict(priority_key) do update set
		   identifier = excluded.identifier,
		   additional_name = excluded.additional_name,
		   is_special_follow = excluded.is_special_follow,
		   updated_at = excluded.updated_at
		 where excluded.updated_at >= birdclaw_profile_priorities.updated_at`,
	).run(
		row.priorityKey,
		row.identifier,
		row.additionalName,
		row.isSpecialFollow,
		row.updatedAt,
	);
}

export function getOrPromoteProfilePriority(
	lookup: { handle: string; identifier?: string },
	db: Database = getNativeDb({ seedDemoData: false }),
	now = new Date(),
) {
	const handle = normalizeHandle(lookup.handle);
	if (!handle) throw new Error("A valid X handle is required.");
	const identifier = normalizeProfilePriorityIdentifier(lookup.identifier);
	if (!identifier) return getProfilePriority({ handle }, db);
	const priorityKey = `id:${identifier}`;
	const stable = getRowByKey(db, priorityKey);
	const provisional = getRowByKey(db, `handle:${handle}`);
	if (
		stable &&
		provisional?.isSpecialFollow === 0 &&
		provisional.updatedAt <= stable.updatedAt
	) {
		return rowToStatus(stable, handle);
	}
	if (provisional) {
		const provisionalIsNewer =
			!stable || provisional.updatedAt > stable.updatedAt;
		const tombstoneAt = [
			now.toISOString(),
			stable?.updatedAt,
			provisional.updatedAt,
		]
			.filter((value): value is string => Boolean(value))
			.sort()
			.at(-1) as string;
		db.transaction(() => {
			if (provisionalIsNewer) {
				upsertPriorityRow(db, {
					priorityKey,
					identifier,
					additionalName: handle,
					isSpecialFollow: provisional.isSpecialFollow,
					updatedAt: tombstoneAt,
				});
			} else if (stable) {
				upsertPriorityRow(db, {
					...stable,
					additionalName: handle,
					updatedAt: tombstoneAt,
				});
			}
			upsertPriorityRow(db, {
				...provisional,
				isSpecialFollow: 0,
				updatedAt: tombstoneAt,
			});
			db.prepare(
				`delete from sync_cache
				 where cache_key like 'period-digest:%'
				    or cache_key like 'period-digest-latest:%'`,
			).run();
		})();
	}
	return getProfilePriority({ handle, identifier }, db);
}

export function setProfileSpecialFollow(
	input: {
		handle: string;
		identifier?: string;
		specialFollow: boolean;
	},
	db: Database = getNativeDb({ seedDemoData: false }),
	now = new Date(),
) {
	const handle = normalizeHandle(input.handle);
	if (!handle) throw new Error("A valid X handle is required.");
	const identifier = normalizeProfilePriorityIdentifier(input.identifier);
	if (identifier.length > 128) {
		throw new Error("Profile identifier is too long.");
	}
	const updatedAt = now.toISOString();
	const priorityKey = identifier ? `id:${identifier}` : `handle:${handle}`;

	db.transaction(() => {
		upsertPriorityRow(db, {
			priorityKey,
			identifier: identifier || null,
			additionalName: handle,
			isSpecialFollow: input.specialFollow ? 1 : 0,
			updatedAt,
		});
		if (identifier) {
			upsertPriorityRow(db, {
				priorityKey: `handle:${handle}`,
				identifier: null,
				additionalName: handle,
				isSpecialFollow: 0,
				updatedAt,
			});
		}
		db.prepare(
			`delete from sync_cache
			 where cache_key like 'period-digest:%'
			    or cache_key like 'period-digest-latest:%'`,
		).run();
	})();

	return rowToStatus(getRowByKey(db, priorityKey), handle);
}

export function listProfilePriorityRows(
	db: Database = getReadDb({ seedDemoData: false }),
) {
	return db
		.prepare(
			`select
			   priority_key as priorityKey,
			   identifier,
			   additional_name as additionalName,
			   is_special_follow as isSpecialFollow,
			   updated_at as updatedAt
			 from birdclaw_profile_priorities
			 order by priority_key`,
		)
		.all() as ProfilePriorityRow[];
}

export function mergeProfilePriorityRows(
	rows: readonly ProfilePriorityRow[],
	db: Database = getNativeDb({ seedDemoData: false }),
) {
	const beforeFingerprint = fingerprintForRows(listProfilePriorityRows(db));
	const normalizedRows = rows.map(normalizedPriorityRow);
	db.transaction(() => {
		for (const row of normalizedRows) upsertPriorityRow(db, row);
	})();
	const mergedRows = listProfilePriorityRows(db);
	if (fingerprintForRows(mergedRows) !== beforeFingerprint) {
		db.prepare(
			`delete from sync_cache
			 where cache_key like 'period-digest:%'
			    or cache_key like 'period-digest-latest:%'`,
		).run();
	}
	return mergedRows;
}

export function remapProfilePriorityRowsToDatabase(
	rows: readonly ProfilePriorityRow[],
	_db: Database,
) {
	// Stable X user IDs are already normalized (42 and profile_user_42 both
	// become 42). Never remap by handle: X handles can be renamed or reused by a
	// different account, and doing so would transfer a priority to the wrong user.
	return rows.map(normalizedPriorityRow);
}

function fingerprintForRows(rows: readonly ProfilePriorityRow[]) {
	return createHash("sha1")
		.update(
			JSON.stringify(
				rows
					.filter((row) => row.isSpecialFollow === 1)
					.map((row) => row.priorityKey)
					.sort((left, right) => left.localeCompare(right)),
			),
		)
		.digest("hex");
}

export function createProfilePrioritySnapshot(
	db: Database = getReadDb({ seedDemoData: false }),
): ProfilePrioritySnapshot {
	const rows = listProfilePriorityRows(db);
	const enabledRows = rows.filter((row) => row.isSpecialFollow === 1);
	const identifiers = new Set(
		enabledRows
			.map((row) => normalizeProfilePriorityIdentifier(row.identifier))
			.filter(Boolean),
	);
	const handleOnly = new Set(
		enabledRows
			.filter((row) => !normalizeProfilePriorityIdentifier(row.identifier))
			.map((row) => normalizeHandle(row.additionalName))
			.filter(Boolean),
	);
	const priorityProfileIds = [
		...new Set(
			enabledRows.flatMap((row) => {
				const identifier = normalizeProfilePriorityIdentifier(row.identifier);
				return identifier ? [identifier, `profile_user_${identifier}`] : [];
			}),
		),
	];
	const fingerprint = fingerprintForRows(rows);

	return {
		fingerprint,
		rows,
		priorityProfileIds,
		priorityHandleOnlyHandles: [...handleOnly],
		isSpecialFollow: ({ handle, identifier }) => {
			const normalizedIdentifier =
				normalizeProfilePriorityIdentifier(identifier);
			if (normalizedIdentifier) return identifiers.has(normalizedIdentifier);
			return handleOnly.has(normalizeHandle(handle));
		},
	};
}
