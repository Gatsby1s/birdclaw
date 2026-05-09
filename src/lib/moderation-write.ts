import type { Database } from "./sqlite";
import type { ActionsTransport } from "./config";
import { getNativeDb } from "./db";
import {
	getAccountHandle,
	getDefaultAccountId,
	normalizeProfileQuery,
	resolveProfile,
} from "./moderation-target";

export interface ModerationActionOptions {
	transport?: ActionsTransport;
}

interface ResolveModerationTargetParams {
	accountId: string;
	query: string;
	selfActionError: string;
}

export async function resolveModerationTarget({
	accountId,
	query,
	selfActionError,
}: ResolveModerationTargetParams) {
	const db = getNativeDb();
	const resolvedAccountId = accountId || getDefaultAccountId(db);
	const accountHandle = getAccountHandle(db, resolvedAccountId);
	if (normalizeProfileQuery(query) === accountHandle) {
		throw new Error(selfActionError);
	}

	const resolved = await resolveProfile(query);
	return {
		db,
		resolved,
		resolvedAccountId,
		actionQuery:
			resolved.externalUserId ??
			resolved.profile.handle ??
			normalizeProfileQuery(query),
	};
}

export function writeModerationRow(
	db: Database,
	table: "blocks" | "mutes",
	accountId: string,
	profileId: string,
	createdAt: string,
) {
	db.prepare(
		`
    insert into ${table} (account_id, profile_id, source, created_at)
    values (?, ?, 'manual', ?)
    on conflict(account_id, profile_id) do update set
      source = excluded.source,
      created_at = excluded.created_at
    `,
	).run(accountId, profileId, createdAt);
}

export function deleteModerationRow(
	db: Database,
	table: "blocks" | "mutes",
	accountId: string,
	profileId: string,
) {
	db.prepare(
		`delete from ${table} where account_id = ? and profile_id = ?`,
	).run(accountId, profileId);
}
