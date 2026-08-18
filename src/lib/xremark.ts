import { z } from "zod";
import { getNativeDb, getReadDb } from "./db";
import type { Database } from "./sqlite";
import type {
	EmbeddedTweet,
	ProfileRecord,
	TimelineItem,
	TweetEntities,
	XRemarkAnnotation,
	XRemarkSyncStatus,
} from "./types";

const xRemarkIdSchema = z
	.union([z.string(), z.number().finite()])
	.transform((value) => String(value).trim())
	.pipe(z.string().min(1).max(128));

const xRemarkTimestampSchema = z.number().finite().nonnegative().optional();

const xRemarkTagSchema = z.looseObject({
	id: xRemarkIdSchema,
	name: z.string().max(200).default(""),
});

const xRemarkCategorySchema = z.looseObject({
	id: xRemarkIdSchema,
	name: z.string().max(200).default(""),
});

const xRemarkProfileNoteSchema = z.looseObject({
	identifier: xRemarkIdSchema,
	additionalName: z.string().max(100).default(""),
	givenName: z.string().max(500).default(""),
	avatar: z.string().max(4_096).nullable().optional(),
	remark: z.string().max(10_000).default(""),
	description: z.string().max(100_000).default(""),
	tags: z.array(xRemarkIdSchema).max(200).default([]),
	category: xRemarkIdSchema.nullable().optional(),
	createTime: xRemarkTimestampSchema,
	updateTime: xRemarkTimestampSchema,
});

export const xRemarkBackupSchema = z.looseObject({
	database: z.looseObject({
		name: z.literal("xRemark"),
		version: z.number().int().nonnegative().max(100),
		backupID: z.string().min(1).max(128),
		backupTime: z.number().finite().nonnegative(),
	}),
	remarks: z.array(xRemarkProfileNoteSchema).max(50_000),
	tags: z.array(xRemarkTagSchema).max(10_000).default([]),
	categories: z.array(xRemarkCategorySchema).max(10_000).default([]),
});

export type XRemarkBackup = z.infer<typeof xRemarkBackupSchema>;

type XRemarkNoteRow = {
	identifier: string;
	additional_name: string;
	given_name: string;
	remark: string;
	description: string;
	tags_json: string;
	category_name: string | null;
	source_updated_at: number | null;
	stable_profile_exists: number;
};

type XRemarkImportStateRow = {
	backup_id: string | null;
	backup_time: number | null;
	source_version: number;
	imported_at: string;
	annotation_count: number;
};

type BirdclawProfileNoteRow = {
	identifier: string | null;
	additional_name: string;
	remark: string;
	description: string | null;
	tags_json: string | null;
	category_name: string | null;
	updated_at: string;
};

export type XRemarkOutboundChange = {
	revision: number;
	identifier: string;
	handle: string;
	displayName: string;
	remark: string;
	description: string;
	tags: string[];
	category: string | null;
	base: XRemarkComparableState;
	acceptableBases: XRemarkComparableState[];
	updatedAt: string;
};

export type XRemarkComparableState =
	| { exists: false }
	| {
			exists: true;
			remark: string;
			description: string;
			tags: string[];
			category: string | null;
	  };

type AnnotationMaps = {
	byIdentifier: Map<string, XRemarkAnnotation>;
	byHandle: Map<string, XRemarkAnnotation>;
};

function normalizedHandle(value: string | null | undefined) {
	const handle = value?.trim().replace(/^@/, "").toLowerCase() ?? "";
	return /^[a-z0-9_]{1,15}$/.test(handle) ? handle : "";
}

function isStableXIdentifier(value: string) {
	return /^\d+$/.test(value);
}

function identifierCandidates(profileId: string) {
	const candidates = [profileId];
	if (profileId.startsWith("profile_user_")) {
		const externalId = profileId.slice("profile_user_".length);
		if (isStableXIdentifier(externalId)) candidates.push(externalId);
	} else if (isStableXIdentifier(profileId)) {
		candidates.push(`profile_user_${profileId}`);
	}
	return candidates;
}

function storedProfileIdentifier(value: string | null | undefined) {
	const identifier = value?.trim() ?? "";
	if (!identifier) return "";
	if (identifier.startsWith("profile_user_")) {
		const externalId = identifier.slice("profile_user_".length);
		if (isStableXIdentifier(externalId)) return externalId;
	}
	return identifier;
}

function resolveStableXIdentifier(
	lookup: { handle: string; identifier?: string },
	db: Database,
) {
	const supplied = storedProfileIdentifier(lookup.identifier);
	if (isStableXIdentifier(supplied)) return supplied;
	const imported = db
		.prepare(
			`select identifier
			 from xremark_profile_notes
			 where identifier = ? or lower(additional_name) = ?
			 order by case when identifier = ? then 0 else 1 end
			 limit 1`,
		)
		.get(supplied, normalizedHandle(lookup.handle), supplied) as
		| { identifier: string }
		| undefined;
	if (imported && isStableXIdentifier(imported.identifier)) {
		return imported.identifier;
	}
	const profile = db
		.prepare("select id from profiles where lower(handle) = ? limit 1")
		.get(normalizedHandle(lookup.handle)) as { id: string } | undefined;
	const profileIdentifier = storedProfileIdentifier(profile?.id);
	return isStableXIdentifier(profileIdentifier) ? profileIdentifier : "";
}

function timestampToIso(value: number | null | undefined) {
	if (!value || !Number.isFinite(value)) return undefined;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function parseStringArray(value: string) {
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed)
			? parsed.filter((entry): entry is string => typeof entry === "string")
			: [];
	} catch {
		return [];
	}
}

function normalizeTagNames(values: string[]) {
	const tags: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		const tag = value.trim();
		const key = tag.toLocaleLowerCase();
		if (!tag || tag.length > 200 || seen.has(key)) continue;
		seen.add(key);
		tags.push(tag);
	}
	return tags.slice(0, 200);
}

function comparableState(
	annotation: XRemarkAnnotation | null | undefined,
): XRemarkComparableState {
	return annotation
		? {
				exists: true,
				remark: annotation.remark,
				description: annotation.description,
				tags: normalizeTagNames(annotation.tags),
				category: annotation.category ?? null,
			}
		: { exists: false };
}

function outboundState(input: {
	remark: string;
	description: string;
	tags: string[];
	category: string | null;
}): XRemarkComparableState {
	const tags = normalizeTagNames(input.tags);
	const category = input.category?.trim() || null;
	if (!input.remark && !input.description && tags.length === 0 && !category) {
		return { exists: false };
	}
	return {
		exists: true,
		remark: input.remark,
		description: input.description,
		tags,
		category,
	};
}

function parseComparableStates(value: string | null) {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value) as unknown;
		const candidates = Array.isArray(parsed) ? parsed : [parsed];
		return candidates.filter((candidate): candidate is XRemarkComparableState =>
			Boolean(
				candidate &&
				typeof candidate === "object" &&
				"exists" in candidate &&
				typeof candidate.exists === "boolean",
			),
		);
	} catch {
		return [];
	}
}

function uniqueComparableStates(states: XRemarkComparableState[]) {
	const seen = new Set<string>();
	return states.filter((state) => {
		const key = JSON.stringify(state);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function rawXRemarkAnnotation(
	lookup: { handle: string; identifier?: string },
	db: Database,
) {
	const normalizedIdentifier = storedProfileIdentifier(lookup.identifier);
	const row = db
		.prepare(
			`select identifier, additional_name, given_name, remark, description,
			        tags_json, category_name, source_updated_at,
			        1 as stable_profile_exists
			 from xremark_profile_notes
			 where (? <> '' and identifier = ?)
			    or (? = '' and lower(additional_name) = ?)
			 order by case when identifier = ? then 0 else 1 end
			 limit 1`,
		)
		.get(
			normalizedIdentifier,
			normalizedIdentifier,
			normalizedIdentifier,
			normalizedHandle(lookup.handle),
			normalizedIdentifier,
		) as XRemarkNoteRow | undefined;
	return row ? annotationFromRow(row) : null;
}

function annotationFromRow(row: XRemarkNoteRow): XRemarkAnnotation {
	const sourceUpdatedAt = timestampToIso(row.source_updated_at);
	return {
		identifier: row.identifier,
		handle: row.additional_name,
		...(row.given_name ? { displayName: row.given_name } : {}),
		remark: row.remark,
		description: row.description,
		tags: parseStringArray(row.tags_json),
		...(row.category_name ? { category: row.category_name } : {}),
		...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
	};
}

function hasVisibleAnnotation(annotation: XRemarkAnnotation) {
	return Boolean(
		annotation.remark ||
		annotation.description ||
		annotation.tags.length > 0 ||
		annotation.category,
	);
}

function listAnnotationMaps(db: Database): AnnotationMaps {
	const rows = db
		.prepare(
			`select identifier, additional_name, given_name, remark, description,
			        tags_json, category_name, source_updated_at,
			        exists (
			          select 1
			          from profiles profile
			          where profile.id = xremark_profile_notes.identifier
			             or profile.id = 'profile_user_' || xremark_profile_notes.identifier
			        ) as stable_profile_exists
			 from xremark_profile_notes`,
		)
		.all() as XRemarkNoteRow[];
	const byIdentifier = new Map<string, XRemarkAnnotation>();
	const byHandle = new Map<string, XRemarkAnnotation>();

	for (const row of rows) {
		const annotation = annotationFromRow(row);
		if (!hasVisibleAnnotation(annotation)) continue;
		byIdentifier.set(annotation.identifier, annotation);
		if (isStableXIdentifier(annotation.identifier)) {
			byIdentifier.set(`profile_user_${annotation.identifier}`, annotation);
		}
		const handle = normalizedHandle(annotation.handle);
		if (handle && !row.stable_profile_exists) byHandle.set(handle, annotation);
	}

	const overrides = db
		.prepare(
			`select identifier, additional_name, remark, description,
			        tags_json, category_name, updated_at
			 from birdclaw_profile_notes
			 order by updated_at asc`,
		)
		.all() as BirdclawProfileNoteRow[];
	for (const override of overrides) {
		const handle = normalizedHandle(override.additional_name);
		const storedIdentifier = storedProfileIdentifier(override.identifier);
		const existing = storedIdentifier
			? identifierCandidates(storedIdentifier)
					.map((identifier) => byIdentifier.get(identifier))
					.find(Boolean)
			: handle
				? byHandle.get(handle)
				: undefined;
		const identifier =
			storedIdentifier || existing?.identifier || `handle:${handle}`;
		const annotation: XRemarkAnnotation = {
			identifier,
			handle: override.additional_name || existing?.handle || handle,
			...(existing?.displayName ? { displayName: existing.displayName } : {}),
			remark: override.remark,
			description: override.description ?? existing?.description ?? "",
			tags:
				override.tags_json == null
					? (existing?.tags ?? [])
					: parseStringArray(override.tags_json),
			...(override.category_name || existing?.category
				? { category: override.category_name || existing?.category }
				: {}),
			sourceUpdatedAt: override.updated_at,
		};
		const identifiers = new Set([
			...identifierCandidates(identifier),
			...(existing ? identifierCandidates(existing.identifier) : []),
		]);
		const handles = storedIdentifier
			? new Set<string>()
			: new Set([handle, normalizedHandle(existing?.handle)].filter(Boolean));
		if (hasVisibleAnnotation(annotation)) {
			for (const candidate of identifiers) {
				byIdentifier.set(candidate, annotation);
			}
			for (const candidate of handles) byHandle.set(candidate, annotation);
		} else {
			for (const candidate of identifiers) byIdentifier.delete(candidate);
			for (const candidate of handles) byHandle.delete(candidate);
		}
	}

	return { byIdentifier, byHandle };
}

function annotationForProfile(profile: ProfileRecord, maps: AnnotationMaps) {
	for (const identifier of identifierCandidates(profile.id)) {
		const annotation = maps.byIdentifier.get(identifier);
		if (annotation) return annotation;
	}
	return maps.byHandle.get(normalizedHandle(profile.handle));
}

function enrichProfile(profile: ProfileRecord, maps: AnnotationMaps) {
	const annotation = annotationForProfile(profile, maps);
	return annotation ? { ...profile, xRemark: annotation } : profile;
}

function enrichEntities(entities: TweetEntities, maps: AnnotationMaps) {
	if (!entities.mentions?.some((mention) => mention.profile)) return entities;
	return {
		...entities,
		mentions: entities.mentions.map((mention) =>
			mention.profile
				? { ...mention, profile: enrichProfile(mention.profile, maps) }
				: mention,
		),
	};
}

function enrichEmbeddedTweet(tweet: EmbeddedTweet, maps: AnnotationMaps) {
	return {
		...tweet,
		author: enrichProfile(tweet.author, maps),
		entities: enrichEntities(tweet.entities, maps),
	};
}

export function createXRemarkAnnotationResolver(
	db: Database = getReadDb({ seedDemoData: false }),
) {
	const maps = listAnnotationMaps(db);
	return (lookup: { handle?: string; identifier?: string }) => {
		if (lookup.identifier) {
			const annotation = identifierCandidates(lookup.identifier)
				.map((identifier) => maps.byIdentifier.get(identifier))
				.find(Boolean);
			if (annotation) return annotation;
		}
		return maps.byHandle.get(normalizedHandle(lookup.handle)) ?? null;
	};
}

export function enrichTimelineItemsWithXRemark(
	items: TimelineItem[],
	db: Database = getReadDb(),
) {
	const maps = listAnnotationMaps(db);
	return items.map((item) => ({
		...item,
		author: enrichProfile(item.author, maps),
		entities: enrichEntities(item.entities, maps),
		...(item.replyToTweet
			? { replyToTweet: enrichEmbeddedTweet(item.replyToTweet, maps) }
			: {}),
		...(item.quotedTweet
			? { quotedTweet: enrichEmbeddedTweet(item.quotedTweet, maps) }
			: {}),
		...(item.retweetedTweet
			? { retweetedTweet: enrichEmbeddedTweet(item.retweetedTweet, maps) }
			: {}),
	}));
}

export function enrichEmbeddedTweetsWithXRemark(
	items: EmbeddedTweet[],
	db: Database = getReadDb(),
) {
	const maps = listAnnotationMaps(db);
	return items.map((item) => enrichEmbeddedTweet(item, maps));
}

export function saveBirdclawProfileRemark(
	input: {
		handle: string;
		identifier?: string;
		remark: string;
		description?: string;
		tags?: string[];
	},
	db: Database = getNativeDb({ seedDemoData: false }),
) {
	const handle = normalizedHandle(input.handle);
	if (!handle) throw new Error("A valid X handle is required.");
	const suppliedIdentifier = storedProfileIdentifier(input.identifier);
	if (suppliedIdentifier.length > 128)
		throw new Error("Profile identifier is too long.");
	const identifier = resolveStableXIdentifier(
		{ handle, ...(input.identifier ? { identifier: input.identifier } : {}) },
		db,
	);
	const remark = input.remark.trim();
	if (remark.length > 80) {
		throw new Error("Profile remark must be 80 characters or fewer.");
	}
	const noteKey = identifier ? `id:${identifier}` : `handle:${handle}`;
	const previousOverride = db
		.prepare(
			`select remark, description, tags_json, category_name, base_json
			 from birdclaw_profile_notes
			 where note_key = ?
			    or (? <> '' and identifier = ?)
			    or (identifier is null and lower(additional_name) = ?)
			 order by case when note_key = ? then 0 else 1 end, updated_at desc
			 limit 1`,
		)
		.get(noteKey, identifier, identifier, handle, noteKey) as
		| {
				remark: string;
				description: string | null;
				tags_json: string | null;
				category_name: string | null;
				base_json: string | null;
		  }
		| undefined;
	const description =
		input.description === undefined
			? (previousOverride?.description ?? null)
			: input.description.trim();
	if (description != null && description.length > 300) {
		throw new Error("Profile description must be 300 characters or fewer.");
	}
	const tagsJson =
		input.tags === undefined
			? (previousOverride?.tags_json ?? null)
			: JSON.stringify(normalizeTagNames(input.tags));
	const categoryName = previousOverride?.category_name ?? null;
	const imported = rawXRemarkAnnotation(
		{ handle, ...(identifier ? { identifier } : {}) },
		db,
	);
	const acceptableBases = parseComparableStates(
		previousOverride?.base_json ?? null,
	);
	if (acceptableBases.length === 0) {
		acceptableBases.push(comparableState(imported));
	}
	if (previousOverride) {
		acceptableBases.push(
			outboundState({
				remark: previousOverride.remark,
				description:
					previousOverride.description ?? imported?.description ?? "",
				tags:
					previousOverride.tags_json == null
						? (imported?.tags ?? [])
						: parseStringArray(previousOverride.tags_json),
				category: previousOverride.category_name ?? imported?.category ?? null,
			}),
		);
	}
	const baseJson = JSON.stringify(uniqueComparableStates(acceptableBases));
	const updatedAt = new Date().toISOString();

	db.transaction(() => {
		db.prepare(
			`insert into xremark_outbound_state (
			   id, next_revision, last_acked_revision
			 ) values (1, 0, 0)
			 on conflict(id) do nothing`,
		).run();
		const state = db
			.prepare("select next_revision from xremark_outbound_state where id = 1")
			.get() as { next_revision: number };
		const revision = Math.min(
			Number.MAX_SAFE_INTEGER,
			Math.max(0, state.next_revision) + 1,
		);
		db.prepare(
			"update xremark_outbound_state set next_revision = ? where id = 1",
		).run(revision);
		db.prepare(
			`delete from birdclaw_profile_notes
			 where note_key <> ?
			   and (
			     (? <> '' and identifier = ?)
			     or (identifier is null and lower(additional_name) = ?)
			   )`,
		).run(noteKey, identifier, identifier, handle);
		db.prepare(
			`insert into birdclaw_profile_notes (
			   note_key, identifier, additional_name, remark, description,
			   tags_json, category_name, sync_revision, base_json, updated_at
			 ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 on conflict(note_key) do update set
			   identifier = excluded.identifier,
			   additional_name = excluded.additional_name,
			   remark = excluded.remark,
			   description = excluded.description,
			   tags_json = excluded.tags_json,
			   category_name = excluded.category_name,
			   sync_revision = excluded.sync_revision,
			   base_json = excluded.base_json,
			   updated_at = excluded.updated_at`,
		).run(
			noteKey,
			identifier || null,
			handle,
			remark,
			description,
			tagsJson,
			categoryName,
			identifier ? revision : null,
			baseJson,
			updatedAt,
		);
	})();

	return getXRemarkSyncStatus(
		{ handle, ...(identifier ? { identifier } : {}) },
		db,
	);
}

export function listPendingXRemarkChanges(
	db: Database = getReadDb({ seedDemoData: false }),
): { changes: XRemarkOutboundChange[]; latestRevision: number } {
	const state = db
		.prepare(
			`select next_revision, last_acked_revision
			 from xremark_outbound_state where id = 1`,
		)
		.get() as
		| { next_revision: number; last_acked_revision: number }
		| undefined;
	const rows = db
		.prepare(
			`select note.sync_revision as revision,
			        note.identifier,
			        note.additional_name as handle,
			        coalesce(imported.given_name, profile.display_name, '') as display_name,
			        note.remark,
			        coalesce(note.description, imported.description, '') as description,
			        coalesce(note.tags_json, imported.tags_json, '[]') as tags_json,
			        coalesce(note.category_name, imported.category_name) as category_name,
			        note.base_json,
			        note.updated_at
			 from birdclaw_profile_notes note
			 left join xremark_profile_notes imported
			   on imported.identifier = note.identifier
			 left join profiles profile
			   on profile.id = note.identifier
			   or profile.id = 'profile_user_' || note.identifier
			 where note.sync_revision is not null
			 order by note.sync_revision asc
			 limit 5000`,
		)
		.all() as Array<{
		revision: number;
		identifier: string;
		handle: string;
		display_name: string;
		remark: string;
		description: string;
		tags_json: string;
		category_name: string | null;
		base_json: string | null;
		updated_at: string;
	}>;
	const changes = rows.map((row) => {
		const acceptableBases = parseComparableStates(row.base_json);
		const base = acceptableBases[0] ?? { exists: false };
		return {
			revision: row.revision,
			identifier: storedProfileIdentifier(row.identifier),
			handle: normalizedHandle(row.handle),
			displayName: row.display_name,
			remark: row.remark,
			description: row.description,
			tags: parseStringArray(row.tags_json),
			category: row.category_name,
			base,
			acceptableBases: acceptableBases.length > 0 ? acceptableBases : [base],
			updatedAt: row.updated_at,
		};
	});
	return {
		latestRevision: changes.at(-1)?.revision ?? state?.last_acked_revision ?? 0,
		changes,
	};
}

export function acknowledgeXRemarkChanges(
	input: { applied: number[]; conflicts: number[] },
	db: Database = getNativeDb({ seedDemoData: false }),
) {
	const revisions = [...new Set([...input.applied, ...input.conflicts])];
	if (
		revisions.some(
			(revision) => !Number.isSafeInteger(revision) || revision < 0,
		)
	) {
		throw new Error("Invalid X Remark change acknowledgement.");
	}
	db.transaction(() => {
		const state = db
			.prepare(
				`select next_revision, last_acked_revision
				 from xremark_outbound_state where id = 1`,
			)
			.get() as
			| { next_revision: number; last_acked_revision: number }
			| undefined;
		if (
			!state ||
			revisions.some((revision) => revision > state.next_revision)
		) {
			throw new Error("X Remark acknowledged an unknown change revision.");
		}
		const remove = db.prepare(
			"delete from birdclaw_profile_notes where sync_revision = ?",
		);
		for (const revision of revisions) remove.run(revision);
		const acknowledgedRevision = Math.max(
			state.last_acked_revision,
			...revisions,
		);
		db.prepare(
			`update xremark_outbound_state
			 set last_acked_revision = max(last_acked_revision, ?)
			 where id = 1`,
		).run(acknowledgedRevision);
	})();
	return listPendingXRemarkChanges(db);
}

export class XRemarkImportError extends Error {
	readonly code: "older-backup";

	constructor(message: string) {
		super(message);
		this.name = "XRemarkImportError";
		this.code = "older-backup";
	}
}

export function importXRemarkBackup(
	backup: XRemarkBackup,
	db: Database = getNativeDb({ seedDemoData: false }),
	options: { allowOlder?: boolean } = {},
) {
	const previousState = db
		.prepare("select backup_time from xremark_import_state where id = 1")
		.get() as { backup_time?: number | null } | undefined;
	if (
		!options.allowOlder &&
		previousState?.backup_time != null &&
		backup.database.backupTime < previousState.backup_time
	) {
		throw new XRemarkImportError(
			"This X Remark backup is older than the currently imported snapshot.",
		);
	}
	const tagNames = new Map(
		backup.tags
			.filter((tag) => tag.name.trim())
			.map((tag) => [tag.id, tag.name.trim()]),
	);
	const categoryNames = new Map(
		backup.categories
			.filter((category) => category.name.trim())
			.map((category) => [category.id, category.name.trim()]),
	);
	const importedAt = new Date().toISOString();
	const notesByIdentifier = new Map<string, XRemarkBackup["remarks"][number]>();

	for (const note of backup.remarks) {
		const previous = notesByIdentifier.get(note.identifier);
		if (!previous || (note.updateTime ?? 0) >= (previous.updateTime ?? 0)) {
			notesByIdentifier.set(note.identifier, note);
		}
	}

	const insert = db.prepare(`
    insert into xremark_profile_notes (
      identifier, additional_name, given_name, remark, description,
      tags_json, category_name, source_created_at, source_updated_at,
      imported_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
	const replaceState = db.prepare(`
    insert into xremark_import_state (
      id, backup_id, backup_time, source_version, imported_at, annotation_count
    ) values (1, ?, ?, ?, ?, ?)
    on conflict(id) do update set
      backup_id = excluded.backup_id,
      backup_time = excluded.backup_time,
      source_version = excluded.source_version,
      imported_at = excluded.imported_at,
      annotation_count = excluded.annotation_count
  `);

	db.transaction(() => {
		db.prepare("delete from xremark_profile_notes").run();
		for (const note of notesByIdentifier.values()) {
			const tags = note.tags
				.map((tagId) => tagNames.get(tagId))
				.filter((tag): tag is string => Boolean(tag));
			insert.run(
				note.identifier,
				note.additionalName.trim().replace(/^@/, ""),
				note.givenName.trim(),
				note.remark.trim(),
				note.description.trim(),
				JSON.stringify([...new Set(tags)]),
				note.category ? (categoryNames.get(note.category) ?? null) : null,
				note.createTime ?? null,
				note.updateTime ?? null,
				importedAt,
			);
		}
		replaceState.run(
			backup.database.backupID,
			backup.database.backupTime,
			backup.database.version,
			importedAt,
			notesByIdentifier.size,
		);
	})();

	return getXRemarkSyncStatus({}, db);
}

export function getXRemarkSyncStatus(
	lookup: { handle?: string; identifier?: string } = {},
	db: Database = getReadDb({ seedDemoData: false }),
): XRemarkSyncStatus {
	const state = db
		.prepare(
			`select backup_id, backup_time, source_version, imported_at,
			        annotation_count
			 from xremark_import_state
			 where id = 1`,
		)
		.get() as XRemarkImportStateRow | undefined;
	const matchedProfileCount = Number(
		(
			db
				.prepare(
					`select count(*) as count
					 from xremark_profile_notes note
					 where exists (
					   select 1
					   from profiles profile
					   where profile.id = note.identifier
					      or profile.id = 'profile_user_' || note.identifier
					      or lower(profile.handle) = lower(note.additional_name)
					 )`,
				)
				.get() as { count?: number } | undefined
		)?.count ?? 0,
	);
	const normalizedLookupHandle = normalizedHandle(lookup.handle);
	const storedProfile =
		!lookup.identifier && normalizedLookupHandle
			? (db
					.prepare("select id from profiles where lower(handle) = ? limit 1")
					.get(normalizedLookupHandle) as { id?: string } | undefined)
			: undefined;
	const resolvedIdentifier = lookup.identifier ?? storedProfile?.id;
	const annotation = createXRemarkAnnotationResolver(db)({
		...(resolvedIdentifier ? { identifier: resolvedIdentifier } : {}),
		...(normalizedLookupHandle ? { handle: normalizedLookupHandle } : {}),
	});
	const backupTime = timestampToIso(state?.backup_time);

	return {
		imported: Boolean(state),
		...(lookup.handle || lookup.identifier
			? {
					bidirectionalEligible: isStableXIdentifier(
						storedProfileIdentifier(
							annotation?.identifier ?? resolvedIdentifier,
						),
					),
				}
			: {}),
		annotationCount: state?.annotation_count ?? 0,
		matchedProfileCount,
		...(state?.backup_id ? { backupId: state.backup_id } : {}),
		...(backupTime ? { backupTime } : {}),
		...(state?.imported_at ? { importedAt: state.imported_at } : {}),
		...(state ? { sourceVersion: state.source_version } : {}),
		...(lookup.handle || lookup.identifier
			? { annotation: annotation ?? null }
			: {}),
	};
}
