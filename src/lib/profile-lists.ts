import { randomUUID } from "node:crypto";
import { getNativeDb, getReadDb } from "./db";
import { normalizeProfilePriorityIdentifier } from "./profile-priority";
import { profileFromDbRow, type ProfileDbRow } from "./profile-row";
import type { Database } from "./sqlite";
import type {
	ProfileListMember,
	ProfileListMembershipStatus,
	ProfileListSummary,
	ProfileRecord,
} from "./types";

interface ListRow {
	id: string;
	accountId: string;
	name: string;
	description: string;
	memberCount: number;
	createdAt: string;
	updatedAt: string;
}

interface MemberRow {
	listId: string;
	memberKey: string;
	identifier: string | null;
	handle: string;
	addedAt: string;
	updatedAt: string;
}

export interface ProfileListSnapshot {
	list: ProfileListSummary;
	priorityProfileIds: string[];
	priorityHandleOnlyHandles: string[];
}

function normalizeAccountId(value: string) {
	const accountId = value.trim();
	if (!accountId || accountId.length > 128) {
		throw new Error("A valid BirdClaw account is required.");
	}
	return accountId;
}

function normalizeListId(value: string) {
	const listId = value.trim();
	if (!listId || listId.length > 128)
		throw new Error("A valid List is required.");
	return listId;
}

function normalizeListName(value: string) {
	const name = value.replace(/\s+/g, " ").trim();
	if (!name || Array.from(name).length > 25) {
		throw new Error("List names must be between 1 and 25 characters.");
	}
	return name;
}

function normalizeDescription(value: string | undefined) {
	const description = (value ?? "").replace(/\s+/g, " ").trim();
	if (Array.from(description).length > 100) {
		throw new Error("List descriptions can be at most 100 characters.");
	}
	return description;
}

function normalizeHandle(value: string) {
	const handle = value.trim().replace(/^@/, "").toLowerCase();
	if (!/^[a-z0-9_]{1,15}$/.test(handle)) {
		throw new Error("A valid X handle is required.");
	}
	return handle;
}

function assertAccountExists(db: Database, accountId: string) {
	const row = db.prepare("select 1 from accounts where id = ?").get(accountId);
	if (!row) throw new Error("BirdClaw account not found.");
}

function summary(row: ListRow): ProfileListSummary {
	return {
		id: row.id,
		accountId: row.accountId,
		name: row.name,
		description: row.description,
		memberCount: Number(row.memberCount),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

const LIST_SELECT = `
  select list.id,
    list.account_id as accountId,
    list.name,
    list.description,
    (select count(*) from birdclaw_list_members member
      where member.list_id = list.id and member.is_member = 1) as memberCount,
    list.created_at as createdAt,
    list.updated_at as updatedAt
  from birdclaw_lists list
`;

export function listProfileLists(
	accountIdInput: string,
	db: Database = getReadDb({ seedDemoData: false }),
) {
	const accountId = normalizeAccountId(accountIdInput);
	return (
		db
			.prepare(
				`${LIST_SELECT}
         where list.account_id = ? and list.deleted_at is null
         order by list.updated_at desc, lower(list.name), list.id`,
			)
			.all(accountId) as ListRow[]
	).map(summary);
}

export function getProfileList(
	accountIdInput: string,
	listIdInput: string,
	db: Database = getReadDb({ seedDemoData: false }),
) {
	const accountId = normalizeAccountId(accountIdInput);
	const listId = normalizeListId(listIdInput);
	const row = db
		.prepare(
			`${LIST_SELECT}
       where list.account_id = ? and list.id = ? and list.deleted_at is null`,
		)
		.get(accountId, listId) as ListRow | undefined;
	return row ? summary(row) : null;
}

function assertNameAvailable(
	db: Database,
	accountId: string,
	name: string,
	exceptId?: string,
) {
	const existing = db
		.prepare(
			`select id from birdclaw_lists
       where account_id = ? and name = ? collate nocase and deleted_at is null
         and (? is null or id <> ?)
       limit 1`,
		)
		.get(accountId, name, exceptId ?? null, exceptId ?? null);
	if (existing) throw new Error("A List with this name already exists.");
}

export function createProfileList(
	input: { accountId: string; name: string; description?: string },
	db: Database = getNativeDb({ seedDemoData: false }),
	now = new Date(),
) {
	const accountId = normalizeAccountId(input.accountId);
	const name = normalizeListName(input.name);
	const description = normalizeDescription(input.description);
	assertAccountExists(db, accountId);
	assertNameAvailable(db, accountId, name);
	const id = randomUUID();
	const timestamp = now.toISOString();
	db.prepare(
		`insert into birdclaw_lists (
       id, account_id, name, description, created_at, updated_at, deleted_at
     ) values (?, ?, ?, ?, ?, ?, null)`,
	).run(id, accountId, name, description, timestamp, timestamp);
	return getProfileList(accountId, id, db) as ProfileListSummary;
}

export function updateProfileList(
	input: {
		accountId: string;
		listId: string;
		name: string;
		description?: string;
	},
	db: Database = getNativeDb({ seedDemoData: false }),
	now = new Date(),
) {
	const accountId = normalizeAccountId(input.accountId);
	const listId = normalizeListId(input.listId);
	const name = normalizeListName(input.name);
	const description = normalizeDescription(input.description);
	if (!getProfileList(accountId, listId, db))
		throw new Error("List not found.");
	assertNameAvailable(db, accountId, name, listId);
	db.prepare(
		`update birdclaw_lists
     set name = ?, description = ?, updated_at = ?
     where id = ? and account_id = ? and deleted_at is null`,
	).run(name, description, now.toISOString(), listId, accountId);
	return getProfileList(accountId, listId, db) as ProfileListSummary;
}

export function deleteProfileList(
	input: { accountId: string; listId: string },
	db: Database = getNativeDb({ seedDemoData: false }),
	now = new Date(),
) {
	const accountId = normalizeAccountId(input.accountId);
	const listId = normalizeListId(input.listId);
	const timestamp = now.toISOString();
	const result = db
		.prepare(
			`update birdclaw_lists
       set deleted_at = ?, updated_at = ?
       where id = ? and account_id = ? and deleted_at is null`,
		)
		.run(timestamp, timestamp, listId, accountId);
	if (result.changes === 0) throw new Error("List not found.");
	return { ok: true as const, listId };
}

function profileForMember(db: Database, row: MemberRow) {
	const profileRow = row.identifier
		? db
				.prepare(
					`select id, handle, display_name, bio, followers_count,
							 following_count, avatar_hue, avatar_url, location, url,
							 verified_type, entities_json, created_at
						 from profiles
             where id = ? or id = 'profile_user_' || ?
             order by case when id = 'profile_user_' || ? then 0 else 1 end
             limit 1`,
				)
				.get(row.identifier, row.identifier, row.identifier)
		: db
				.prepare(
					`select id, handle, display_name, bio, followers_count,
							 following_count, avatar_hue, avatar_url, location, url,
							 verified_type, entities_json, created_at
						 from profiles where lower(handle) = ? limit 1`,
				)
				.get(row.handle);
	return profileRow ? profileFromDbRow(profileRow as ProfileDbRow) : undefined;
}

function member(row: MemberRow, profile?: ProfileRecord): ProfileListMember {
	return {
		listId: row.listId,
		memberKey: row.memberKey,
		...(row.identifier ? { identifier: row.identifier } : {}),
		handle: profile?.handle ?? row.handle,
		addedAt: row.addedAt,
		updatedAt: row.updatedAt,
		...(profile ? { profile } : {}),
	};
}

export function listProfileListMembers(
	input: { accountId: string; listId: string },
	db: Database = getReadDb({ seedDemoData: false }),
) {
	const list = getProfileList(input.accountId, input.listId, db);
	if (!list) throw new Error("List not found.");
	const rows = db
		.prepare(
			`select list_id as listId, member_key as memberKey, identifier,
         additional_name as handle, added_at as addedAt, updated_at as updatedAt
       from birdclaw_list_members
       where list_id = ? and is_member = 1
       order by updated_at desc, lower(additional_name), member_key`,
		)
		.all(list.id) as MemberRow[];
	return rows.map((row) => member(row, profileForMember(db, row)));
}

export function setProfileListMembership(
	input: {
		accountId: string;
		listId: string;
		handle: string;
		identifier?: string;
		included: boolean;
	},
	db: Database = getNativeDb({ seedDemoData: false }),
	now = new Date(),
) {
	const list = getProfileList(input.accountId, input.listId, db);
	if (!list) throw new Error("List not found.");
	const handle = normalizeHandle(input.handle);
	const identifier = normalizeProfilePriorityIdentifier(input.identifier);
	if (identifier.length > 128)
		throw new Error("Profile identifier is too long.");
	const memberKey = identifier ? `id:${identifier}` : `handle:${handle}`;
	const timestamp = now.toISOString();
	const existing = db
		.prepare(
			`select added_at as addedAt from birdclaw_list_members
       where list_id = ? and member_key = ?`,
		)
		.get(list.id, memberKey) as { addedAt: string } | undefined;

	db.transaction(() => {
		db.prepare(
			`insert into birdclaw_list_members (
         list_id, member_key, identifier, additional_name,
         is_member, added_at, updated_at
       ) values (?, ?, ?, ?, ?, ?, ?)
       on conflict(list_id, member_key) do update set
         identifier = excluded.identifier,
         additional_name = excluded.additional_name,
         is_member = excluded.is_member,
         updated_at = excluded.updated_at
       where excluded.updated_at >= birdclaw_list_members.updated_at`,
		).run(
			list.id,
			memberKey,
			identifier || null,
			handle,
			input.included ? 1 : 0,
			existing?.addedAt ?? timestamp,
			timestamp,
		);
		if (identifier) {
			db.prepare(
				`update birdclaw_list_members
         set is_member = 0, updated_at = ?
         where list_id = ? and member_key = ? and updated_at <= ?`,
			).run(timestamp, list.id, `handle:${handle}`, timestamp);
		}
		db.prepare("update birdclaw_lists set updated_at = ? where id = ?").run(
			timestamp,
			list.id,
		);
	})();

	return {
		listId: list.id,
		memberKey,
		...(identifier ? { identifier } : {}),
		handle,
		included: input.included,
		updatedAt: timestamp,
	};
}

export function getProfileListMembershipStatus(
	input: { accountId: string; handle: string; identifier?: string },
	db: Database = getReadDb({ seedDemoData: false }),
): ProfileListMembershipStatus {
	const handle = normalizeHandle(input.handle);
	const identifier = normalizeProfilePriorityIdentifier(input.identifier);
	const lists = listProfileLists(input.accountId, db).map((list) => {
		const included = Boolean(
			db
				.prepare(
					`select 1 from birdclaw_list_members
             where list_id = ? and is_member = 1
               and (member_key = ? or member_key = ?)
             limit 1`,
				)
				.get(
					list.id,
					identifier ? `id:${identifier}` : `handle:${handle}`,
					`handle:${handle}`,
				),
		);
		return { ...list, included };
	});
	return {
		profile: { handle, ...(identifier ? { identifier } : {}) },
		lists,
	};
}

export function searchProfileListCandidates(
	input: { accountId: string; listId: string; search?: string; limit?: number },
	db: Database = getReadDb({ seedDemoData: false }),
) {
	const list = getProfileList(input.accountId, input.listId, db);
	if (!list) throw new Error("List not found.");
	const search = (input.search ?? "").trim().replace(/^@/, "").toLowerCase();
	const limit = Math.max(1, Math.min(50, Math.floor(input.limit ?? 20)));
	const pattern = `%${search.replace(/[%_]/g, "\\$&")}%`;
	const profileRows = db
		.prepare(
			`select id, handle, display_name, bio, followers_count,
					 following_count, avatar_hue, avatar_url, location, url,
					 verified_type, entities_json, created_at
			 from profiles
       where (? = '' or lower(handle) like ? escape '\\'
         or lower(display_name) like ? escape '\\')
       order by case when lower(handle) = ? then 0 else 1 end,
         followers_count desc, lower(handle)
       limit ?`,
		)
		.all(search, pattern, pattern, search, limit) as ProfileDbRow[];
	const profiles = profileRows.map((row) => profileFromDbRow(row));
	return profiles.map((profile) => {
		const identifier = normalizeProfilePriorityIdentifier(profile.id);
		const included = Boolean(
			db
				.prepare(
					`select 1 from birdclaw_list_members
             where list_id = ? and is_member = 1
               and (member_key = ? or member_key = ?)
             limit 1`,
				)
				.get(
					list.id,
					identifier
						? `id:${identifier}`
						: `handle:${profile.handle.toLowerCase()}`,
					`handle:${profile.handle.toLowerCase()}`,
				),
		);
		return { profile, included };
	});
}

export function createProfileListSnapshot(
	input: { accountId: string; listId: string },
	db: Database = getReadDb({ seedDemoData: false }),
): ProfileListSnapshot {
	const list = getProfileList(input.accountId, input.listId, db);
	if (!list) throw new Error("List not found.");
	const rows = db
		.prepare(
			`select identifier, additional_name as handle
       from birdclaw_list_members
       where list_id = ? and is_member = 1
       order by member_key`,
		)
		.all(list.id) as Array<{ identifier: string | null; handle: string }>;
	const identifiers = rows
		.map((row) => normalizeProfilePriorityIdentifier(row.identifier))
		.filter(Boolean);
	return {
		list,
		priorityProfileIds: [
			...new Set(identifiers.flatMap((id) => [id, `profile_user_${id}`])),
		],
		priorityHandleOnlyHandles: [
			...new Set(
				rows
					.filter((row) => !normalizeProfilePriorityIdentifier(row.identifier))
					.map((row) => row.handle.toLowerCase()),
			),
		],
	};
}
