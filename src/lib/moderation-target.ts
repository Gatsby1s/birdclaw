import type { Database } from "./sqlite";
import { lookupProfileViaBird } from "./bird-actions";
import { getNativeDb } from "./db";
import type { ProfileRecord, XurlMentionUser } from "./types";
import { getExternalUserId, upsertProfileFromXUser } from "./x-profile";
import {
	lookupAuthenticatedUser,
	lookupUsersByHandles,
	lookupUsersByIds,
} from "./xurl";

export interface ResolvedModerationProfile {
	profile: ProfileRecord;
	externalUserId: string | null;
}

export function toProfile(row: Record<string, unknown>): ProfileRecord {
	const followingCount = Number(row.following_count ?? 0);
	return {
		id: String(row.id),
		handle: String(row.handle),
		displayName: String(row.display_name),
		bio: String(row.bio),
		followersCount: Number(row.followers_count),
		...(Number.isFinite(followingCount) ? { followingCount } : {}),
		avatarHue: Number(row.avatar_hue),
		avatarUrl:
			typeof row.avatar_url === "string" ? String(row.avatar_url) : undefined,
		createdAt: String(row.created_at),
	};
}

export function normalizeProfileQuery(value: string) {
	const trimmed = value.trim();
	if (!trimmed) return "";

	const withoutPrefix = trimmed.replace(/^@/, "");
	const urlMatch = withoutPrefix.match(
		/^(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/([^/?#]+)/i,
	);
	return (urlMatch?.[1] ?? withoutPrefix).replace(/^@/, "").trim();
}

export function getDefaultAccountId(db: Database) {
	const row = db
		.prepare(
			`
      select id
      from accounts
      order by is_default desc, created_at asc
      limit 1
      `,
		)
		.get() as { id: string } | undefined;
	return row?.id ?? "acct_primary";
}

export function getAccountHandle(db: Database, accountId: string) {
	const row = db
		.prepare("select handle from accounts where id = ?")
		.get(accountId) as { handle: string } | undefined;
	return row?.handle.replace(/^@/, "") ?? "";
}

export function resolveLocalProfile(
	db: Database,
	normalizedQuery: string,
): ResolvedModerationProfile | null {
	const row = db
		.prepare(
			`
      select id, handle, display_name, bio, followers_count, following_count, avatar_hue, avatar_url, created_at
      from profiles
      where id = ? or handle = ?
      limit 1
      `,
		)
		.get(normalizedQuery, normalizedQuery) as
		| Record<string, unknown>
		| undefined;

	if (!row) {
		return null;
	}

	const profile = toProfile(row);
	return {
		profile,
		externalUserId: getExternalUserId(profile.id),
	};
}

export async function resolveProfile(
	query: string,
): Promise<ResolvedModerationProfile> {
	const db = getNativeDb();
	const normalizedQuery = normalizeProfileQuery(query);
	if (!normalizedQuery) {
		throw new Error("Missing profile handle or id");
	}

	const local = resolveLocalProfile(db, normalizedQuery);
	if (
		local &&
		!local.profile.id.startsWith("profile_group_") &&
		local.externalUserId
	) {
		return local;
	}

	let user: XurlMentionUser | undefined;
	let lastError: unknown;

	try {
		user =
			(await lookupProfileViaBird(local?.profile.handle ?? normalizedQuery)) ??
			undefined;
	} catch (error) {
		lastError = error;
	}

	if (!user) {
		try {
			if (/^\d+$/.test(normalizedQuery)) {
				[user] = await lookupUsersByIds([normalizedQuery]);
			} else {
				[user] = await lookupUsersByHandles([
					local?.profile.handle ?? normalizedQuery,
				]);
			}
		} catch (error) {
			lastError = error;
		}
	}

	if (!user && lastError) {
		if (local) {
			return local;
		}
		throw lastError;
	}

	if (!user) {
		if (local) {
			return local;
		}
		throw new Error(`Profile not found: ${query}`);
	}

	if (local) {
		return upsertProfileFromXUser(db, user);
	}

	const username = String(user.username ?? "").replace(/^@/, "");
	if (username) {
		const localByHandle = resolveLocalProfile(db, username);
		if (localByHandle) {
			return upsertProfileFromXUser(db, user);
		}
	}

	return upsertProfileFromXUser(db, user);
}

export async function getAuthenticatedUserId() {
	try {
		const me = await lookupAuthenticatedUser();
		const id = me?.id;
		return typeof id === "string" && id.length > 0 ? id : null;
	} catch {
		return null;
	}
}
