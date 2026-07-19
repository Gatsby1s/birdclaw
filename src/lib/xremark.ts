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
	const maps = listAnnotationMaps(db);
	const normalizedLookupHandle = normalizedHandle(lookup.handle);
	const storedProfile =
		!lookup.identifier && normalizedLookupHandle
			? (db
					.prepare("select id from profiles where lower(handle) = ? limit 1")
					.get(normalizedLookupHandle) as { id?: string } | undefined)
			: undefined;
	const resolvedIdentifier = lookup.identifier ?? storedProfile?.id;
	const annotation = resolvedIdentifier
		? (identifierCandidates(resolvedIdentifier)
				.map((identifier) => maps.byIdentifier.get(identifier))
				.find(Boolean) ?? maps.byHandle.get(normalizedHandle(lookup.handle)))
		: maps.byHandle.get(normalizedLookupHandle);
	const backupTime = timestampToIso(state?.backup_time);

	return {
		imported: Boolean(state),
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
