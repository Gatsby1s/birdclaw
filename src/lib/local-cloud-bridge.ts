import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Database } from "./sqlite";
import { enqueueDatabaseWrite } from "./database-writer";
import { getNativeDb } from "./db";
import {
	isLocalTwitterCollectorFresh,
	resolveLocalTwitterCollectorAccountId,
} from "./local-twitter-collector";
import {
	listProfilePriorityRows,
	mergeProfilePriorityRows,
	remapProfilePriorityRowsToDatabase,
} from "./profile-priority";
import { replaceTweetFts } from "./tweet-repository";
import { getTwitter6551RuntimeConfig } from "./twitter-6551";

const DEFAULT_INTERVAL_SECONDS = 60;
const DEFAULT_LOOKBACK_HOURS = 24;
const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 250;
const REQUEST_TIMEOUT_MS = 30_000;
const CURSOR_CACHE_PREFIX = "cloud-bridge:cursor:";
const HISTORY_CACHE_PREFIX = "cloud-bridge:history:";
const MAX_CLIENT_BODY_BYTES = 7 * 1024 * 1024;
const MAX_PAGES_PER_RUN = 20;

const bridgePurposeSchema = z.enum(["live", "history"]);

const bridgeCursorSchema = z.object({
	updatedAt: z.string().max(64),
	accountId: z.string().max(256),
	tweetId: z.string().max(256),
	kind: z.string().max(64),
});

const bridgeHistoryStateSchema = z.object({
	version: z.literal(1),
	cursor: bridgeCursorSchema,
	completedAt: z.string().max(64).nullable(),
});

const bridgeAccountSchema = z.object({
	id: z.string().min(1).max(256),
	name: z.string().max(512),
	handle: z.string().max(256),
	externalUserId: z.string().max(256).nullable(),
	transport: z.string().max(64),
	isDefault: z.number().int(),
	createdAt: z.string().max(64),
});

const bridgeProfileSchema = z.object({
	id: z.string().min(1).max(256),
	handle: z.string().min(1).max(256),
	displayName: z.string().max(512),
	bio: z.string().max(100_000),
	followersCount: z.number().int(),
	followingCount: z.number().int(),
	publicMetricsJson: z.string().max(200_000),
	avatarHue: z.number().int(),
	avatarUrl: z.string().max(8_192).nullable(),
	location: z.string().max(2_048).nullable(),
	url: z.string().max(8_192).nullable(),
	verifiedType: z.string().max(256).nullable(),
	entitiesJson: z.string().max(500_000),
	rawJson: z.string().max(1_000_000),
	createdAt: z.string().max(64),
});

const bridgeTweetSchema = z.object({
	id: z.string().min(1).max(256),
	authorProfileId: z.string().min(1).max(256),
	text: z.string().max(1_000_000),
	createdAt: z.string().max(64),
	isReplied: z.number().int(),
	replyToId: z.string().max(256).nullable(),
	likeCount: z.number().int(),
	mediaCount: z.number().int(),
	entitiesJson: z.string().max(500_000),
	mediaJson: z.string().max(1_000_000),
	quotedTweetId: z.string().max(256).nullable(),
});

const bridgeEdgeSchema = z.object({
	accountId: z.string().min(1).max(256),
	tweetId: z.string().min(1).max(256),
	kind: z.enum([
		"home",
		"mention",
		"authored",
		"search",
		"profile",
		"thread_context",
	]),
	firstSeenAt: z.string().max(64),
	lastSeenAt: z.string().max(64),
	seenCount: z.number().int().nonnegative(),
	source: z.string().max(64),
	rawJson: z.string().max(1_000_000),
	updatedAt: z.string().max(64),
});

const bridgeXRemarkAnnotationSchema = z.object({
	identifier: z.string().min(1).max(256),
	handle: z.string().max(256),
	displayName: z.string().max(512),
	remark: z.string().max(10_000),
	description: z.string().max(100_000),
	tags: z.array(z.string().max(200)).max(200),
	categoryName: z.string().max(200).nullable(),
	sourceCreatedAt: z.number().finite().nonnegative().nullable(),
	sourceUpdatedAt: z.number().finite().nonnegative().nullable(),
	importedAt: z.string().max(64),
});

const bridgeXRemarkSnapshotSchema = z.object({
	backupId: z.string().max(256).nullable(),
	backupTime: z.number().finite().nonnegative().nullable(),
	sourceVersion: z.number().int().nonnegative(),
	importedAt: z.string().max(64),
	annotations: z.array(bridgeXRemarkAnnotationSchema).max(50_000),
});

const bridgeProfilePrioritySchema = z
	.object({
		priorityKey: z.string().min(1).max(512),
		identifier: z.string().max(128).nullable(),
		additionalName: z
			.string()
			.trim()
			.regex(/^@?[a-z0-9_]{1,15}$/i),
		isSpecialFollow: z.number().int().min(0).max(1),
		updatedAt: z
			.string()
			.max(64)
			.refine(
				(value) =>
					Number.isFinite(Date.parse(value)) &&
					new Date(value).toISOString() === value,
			),
	})
	.superRefine((row, context) => {
		const handle = row.additionalName.replace(/^@/, "").toLowerCase();
		const identifier = row.identifier?.replace(/^profile_user_/, "") ?? "";
		const expectedKey = identifier ? `id:${identifier}` : `handle:${handle}`;
		if (row.priorityKey !== expectedKey) {
			context.addIssue({
				code: "custom",
				message: "Profile priority key does not match its identity.",
			});
		}
	});

export const localCloudBridgeBatchSchema = z.object({
	version: z.literal(1),
	purpose: bridgePurposeSchema.optional().default("live"),
	sentAt: z.string().max(64),
	caughtUp: z.boolean(),
	cursor: bridgeCursorSchema,
	accounts: z.array(bridgeAccountSchema).max(MAX_BATCH_SIZE),
	profiles: z.array(bridgeProfileSchema).max(MAX_BATCH_SIZE * 2),
	tweets: z.array(bridgeTweetSchema).max(MAX_BATCH_SIZE * 2),
	edges: z.array(bridgeEdgeSchema).max(MAX_BATCH_SIZE),
	xRemarkSnapshot: bridgeXRemarkSnapshotSchema
		.nullable()
		.optional()
		.default(null),
	profilePriorities: z
		.array(bridgeProfilePrioritySchema)
		.max(50_000)
		.optional()
		.default([]),
});

export type LocalCloudBridgeCursor = z.infer<typeof bridgeCursorSchema>;
export type LocalCloudBridgeBatch = z.infer<typeof localCloudBridgeBatchSchema>;

export interface LocalCloudBridgeClientStatus {
	enabled: boolean;
	running: boolean;
	lastSuccessAt: string | null;
	lastError: string | null;
	uploadedEdges: number;
	backfillCompleted: boolean;
	backfillLastSuccessAt: string | null;
	backfillLastError: string | null;
	backfilledEdges: number;
}

export interface LocalCloudBridgeArchiveStats {
	accounts: number;
	profiles: number;
	tweets: number;
	edges: number;
	homeEdges: number;
	homeTweets: number;
}

interface LocalCloudBridgeClientOptions {
	url: string;
	token: string;
	intervalSeconds?: number;
	lookbackHours?: number;
	batchSize?: number;
	accountId?: string;
	fetchImpl?: typeof fetch;
	now?: () => Date;
	isReady?: () => boolean;
}

function positiveNumber(value: string | undefined, fallback: number) {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function placeholders(values: readonly unknown[]) {
	return values.map(() => "?").join(",");
}

function queryByIds<T>(
	db: Database,
	sqlPrefix: string,
	ids: readonly string[],
): T[] {
	if (ids.length === 0) return [];
	return db.prepare(`${sqlPrefix} (${placeholders(ids)})`).all(...ids) as T[];
}

function initialCursor(lookbackHours: number, now = new Date()) {
	return {
		updatedAt: new Date(
			now.getTime() - Math.max(1, lookbackHours) * 60 * 60_000,
		).toISOString(),
		accountId: "",
		tweetId: "",
		kind: "",
	} satisfies LocalCloudBridgeCursor;
}

function bridgeCacheKey(url: string) {
	return `${CURSOR_CACHE_PREFIX}${createHash("sha256")
		.update(url)
		.digest("hex")
		.slice(0, 16)}`;
}

function bridgeHistoryCacheKey(url: string) {
	return `${HISTORY_CACHE_PREFIX}${createHash("sha256")
		.update(url)
		.digest("hex")
		.slice(0, 16)}`;
}

function beginningCursor() {
	return {
		updatedAt: "",
		accountId: "",
		tweetId: "",
		kind: "",
	} satisfies LocalCloudBridgeCursor;
}

function readBridgeCursor(
	db: Database,
	url: string,
	lookbackHours: number,
	now: Date,
) {
	const row = db
		.prepare("select value_json from sync_cache where cache_key = ?")
		.get(bridgeCacheKey(url)) as { value_json?: string } | undefined;
	if (row?.value_json) {
		try {
			return bridgeCursorSchema.parse(JSON.parse(row.value_json));
		} catch {
			// A damaged local cursor safely falls back to a bounded replay.
		}
	}
	return initialCursor(lookbackHours, now);
}

function writeBridgeCursor(
	db: Database,
	url: string,
	cursor: LocalCloudBridgeCursor,
	now: Date,
) {
	db.prepare(
		`
		insert into sync_cache (cache_key, value_json, updated_at)
		values (?, ?, ?)
		on conflict(cache_key) do update set
			value_json = excluded.value_json,
			updated_at = excluded.updated_at
		`,
	).run(bridgeCacheKey(url), JSON.stringify(cursor), now.toISOString());
}

function readBridgeHistoryState(db: Database, url: string) {
	const row = db
		.prepare("select value_json from sync_cache where cache_key = ?")
		.get(bridgeHistoryCacheKey(url)) as { value_json?: string } | undefined;
	if (row?.value_json) {
		try {
			return bridgeHistoryStateSchema.parse(JSON.parse(row.value_json));
		} catch {
			// Replaying from the beginning is safe because cloud imports are idempotent.
		}
	}
	return {
		version: 1,
		cursor: beginningCursor(),
		completedAt: null,
	} satisfies z.infer<typeof bridgeHistoryStateSchema>;
}

function writeBridgeHistoryState(
	db: Database,
	url: string,
	state: z.infer<typeof bridgeHistoryStateSchema>,
	now: Date,
) {
	db.prepare(
		`
		insert into sync_cache (cache_key, value_json, updated_at)
		values (?, ?, ?)
		on conflict(cache_key) do update set
			value_json = excluded.value_json,
			updated_at = excluded.updated_at
		`,
	).run(bridgeHistoryCacheKey(url), JSON.stringify(state), now.toISOString());
}

function scalarCount(db: Database, sql: string) {
	const row = db.prepare(sql).get() as { count?: number } | undefined;
	return Number(row?.count ?? 0);
}

export function getLocalCloudBridgeArchiveStats(
	db = getNativeDb({ seedDemoData: false }),
): LocalCloudBridgeArchiveStats {
	return {
		accounts: scalarCount(db, "select count(*) as count from accounts"),
		profiles: scalarCount(db, "select count(*) as count from profiles"),
		tweets: scalarCount(db, "select count(*) as count from tweets"),
		edges: scalarCount(db, "select count(*) as count from tweet_account_edges"),
		homeEdges: scalarCount(
			db,
			"select count(*) as count from tweet_account_edges where kind = 'home'",
		),
		homeTweets: scalarCount(
			db,
			"select count(distinct tweet_id) as count from tweet_account_edges where kind = 'home'",
		),
	};
}

function parseStoredTags(value: string) {
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed)
			? parsed.filter((entry): entry is string => typeof entry === "string")
			: [];
	} catch {
		return [];
	}
}

function buildXRemarkSnapshot(db: Database) {
	const state = db
		.prepare(
			`select backup_id as backupId, backup_time as backupTime,
			        source_version as sourceVersion, imported_at as importedAt
			 from xremark_import_state where id = 1`,
		)
		.get() as
		| {
				backupId: string | null;
				backupTime: number | null;
				sourceVersion: number;
				importedAt: string;
		  }
		| undefined;
	if (!state) return null;
	const rows = db
		.prepare(
			`select identifier, additional_name as handle,
			        given_name as displayName, remark, description,
			        tags_json as tagsJson, category_name as categoryName,
			        source_created_at as sourceCreatedAt,
			        source_updated_at as sourceUpdatedAt,
			        imported_at as importedAt
			 from xremark_profile_notes
			 order by identifier`,
		)
		.all() as Array<{
		identifier: string;
		handle: string;
		displayName: string;
		remark: string;
		description: string;
		tagsJson: string;
		categoryName: string | null;
		sourceCreatedAt: number | null;
		sourceUpdatedAt: number | null;
		importedAt: string;
	}>;
	return bridgeXRemarkSnapshotSchema.parse({
		...state,
		annotations: rows.map(({ tagsJson, ...row }) => ({
			...row,
			tags: parseStoredTags(tagsJson),
		})),
	});
}

export function buildLocalCloudBridgeBatch({
	cursor,
	purpose = "live",
	lookbackHours = DEFAULT_LOOKBACK_HOURS,
	limit = DEFAULT_BATCH_SIZE,
	accountId,
	now = new Date(),
	db = getNativeDb({ seedDemoData: false }),
}: {
	cursor?: LocalCloudBridgeCursor;
	purpose?: z.infer<typeof bridgePurposeSchema>;
	lookbackHours?: number;
	limit?: number;
	accountId?: string;
	now?: Date;
	db?: Database;
} = {}): LocalCloudBridgeBatch {
	const safeLimit = Math.max(1, Math.min(MAX_BATCH_SIZE, Math.floor(limit)));
	const start = cursor ?? initialCursor(lookbackHours, now);
	const edges = db
		.prepare(
			`
			select
				account_id as accountId,
				tweet_id as tweetId,
				kind,
				first_seen_at as firstSeenAt,
				last_seen_at as lastSeenAt,
				seen_count as seenCount,
				source,
				raw_json as rawJson,
				updated_at as updatedAt
			from tweet_account_edges
			where (? = '' or account_id = ?)
				and (
					updated_at > ?
				or (updated_at = ? and account_id > ?)
				or (updated_at = ? and account_id = ? and tweet_id > ?)
				or (
					updated_at = ? and account_id = ? and tweet_id = ? and kind > ?
				)
				)
			order by updated_at asc, account_id asc, tweet_id asc, kind asc
			limit ?
			`,
		)
		.all(
			accountId ?? "",
			accountId ?? "",
			start.updatedAt,
			start.updatedAt,
			start.accountId,
			start.updatedAt,
			start.accountId,
			start.tweetId,
			start.updatedAt,
			start.accountId,
			start.tweetId,
			start.kind,
			safeLimit,
		) as LocalCloudBridgeBatch["edges"];
	const lastEdge = edges.at(-1);
	const caughtUp = edges.length < safeLimit;
	const nextCursor = lastEdge
		? {
				updatedAt: lastEdge.updatedAt,
				accountId: lastEdge.accountId,
				tweetId: lastEdge.tweetId,
				kind: lastEdge.kind,
			}
		: start;
	const primaryTweetIds = [...new Set(edges.map((edge) => edge.tweetId))];
	const tweetSql = `
		select
			id,
			author_profile_id as authorProfileId,
			text,
			created_at as createdAt,
			is_replied as isReplied,
			reply_to_id as replyToId,
			like_count as likeCount,
			media_count as mediaCount,
			entities_json as entitiesJson,
			media_json as mediaJson,
			quoted_tweet_id as quotedTweetId
		from tweets
		where id in
	`;
	const primaryTweets = queryByIds<LocalCloudBridgeBatch["tweets"][number]>(
		db,
		tweetSql,
		primaryTweetIds,
	);
	const quotedIds = [
		...new Set(
			primaryTweets
				.map((tweet) => tweet.quotedTweetId)
				.filter((id): id is string => Boolean(id)),
		),
	].filter((id) => !primaryTweetIds.includes(id));
	const quotedTweets = queryByIds<LocalCloudBridgeBatch["tweets"][number]>(
		db,
		tweetSql,
		quotedIds,
	);
	const tweets = [...primaryTweets, ...quotedTweets];
	const profileIds = [...new Set(tweets.map((tweet) => tweet.authorProfileId))];
	const profiles = queryByIds<LocalCloudBridgeBatch["profiles"][number]>(
		db,
		`
		select
			id,
			handle,
			display_name as displayName,
			bio,
			followers_count as followersCount,
			following_count as followingCount,
			public_metrics_json as publicMetricsJson,
			avatar_hue as avatarHue,
			avatar_url as avatarUrl,
			location,
			url,
			verified_type as verifiedType,
			entities_json as entitiesJson,
			raw_json as rawJson,
			created_at as createdAt
		from profiles
		where id in
		`,
		profileIds,
	);
	const accountIds = [...new Set(edges.map((edge) => edge.accountId))];
	const accounts = queryByIds<LocalCloudBridgeBatch["accounts"][number]>(
		db,
		`
		select
			id,
			name,
			handle,
			external_user_id as externalUserId,
			transport,
			is_default as isDefault,
			created_at as createdAt
		from accounts
		where id in
		`,
		accountIds,
	);
	return localCloudBridgeBatchSchema.parse({
		version: 1,
		purpose,
		sentAt: now.toISOString(),
		caughtUp,
		cursor: nextCursor,
		accounts,
		profiles,
		tweets,
		edges,
		xRemarkSnapshot:
			caughtUp && purpose === "live" ? buildXRemarkSnapshot(db) : null,
		profilePriorities:
			caughtUp && purpose === "live" ? listProfilePriorityRows(db) : [],
	});
}

export async function importLocalCloudBridgeBatch(input: unknown) {
	const batch = localCloudBridgeBatchSchema.parse(input);
	const result = await enqueueDatabaseWrite((db) => {
		const replaceXRemarkState = db.prepare(`
			insert into xremark_import_state (
				id, backup_id, backup_time, source_version, imported_at,
				annotation_count
			) values (1, ?, ?, ?, ?, ?)
			on conflict(id) do update set
				backup_id = excluded.backup_id,
				backup_time = excluded.backup_time,
				source_version = excluded.source_version,
				imported_at = excluded.imported_at,
				annotation_count = excluded.annotation_count
		`);
		const insertXRemarkAnnotation = db.prepare(`
			insert into xremark_profile_notes (
				identifier, additional_name, given_name, remark, description,
				tags_json, category_name, source_created_at, source_updated_at,
				imported_at
			) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		const upsertAccount = db.prepare(`
			insert into accounts (
				id, name, handle, external_user_id, transport, is_default, created_at
			) values (?, ?, ?, ?, ?, ?, ?)
			on conflict(id) do update set
				name = coalesce(nullif(excluded.name, ''), accounts.name),
				handle = coalesce(nullif(excluded.handle, ''), accounts.handle),
				external_user_id = coalesce(
					excluded.external_user_id,
					accounts.external_user_id
				),
				transport = coalesce(nullif(excluded.transport, ''), accounts.transport),
				is_default = max(accounts.is_default, excluded.is_default),
				created_at = min(accounts.created_at, excluded.created_at)
		`);
		const upsertProfile = db.prepare(`
			insert into profiles (
				id, handle, display_name, bio, followers_count, following_count,
				public_metrics_json, avatar_hue, avatar_url, location, url,
				verified_type, entities_json, raw_json, created_at
			) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			on conflict(id) do update set
				handle = coalesce(nullif(excluded.handle, ''), profiles.handle),
				display_name = coalesce(
					nullif(excluded.display_name, ''),
					profiles.display_name
				),
				bio = coalesce(nullif(excluded.bio, ''), profiles.bio),
				followers_count = max(
					profiles.followers_count,
					excluded.followers_count
				),
				following_count = max(
					profiles.following_count,
					excluded.following_count
				),
				public_metrics_json = case
					when excluded.public_metrics_json not in ('', '{}', 'null')
						then excluded.public_metrics_json
					else profiles.public_metrics_json
				end,
				avatar_hue = case
					when profiles.avatar_hue = 0 then excluded.avatar_hue
					else profiles.avatar_hue
				end,
				avatar_url = coalesce(excluded.avatar_url, profiles.avatar_url),
				location = coalesce(excluded.location, profiles.location),
				url = coalesce(excluded.url, profiles.url),
				verified_type = coalesce(
					excluded.verified_type,
					profiles.verified_type
				),
				entities_json = case
					when excluded.entities_json not in ('', '{}', 'null')
						then excluded.entities_json
					else profiles.entities_json
				end,
				raw_json = case
					when excluded.raw_json not in ('', '{}', 'null')
						then excluded.raw_json
					else profiles.raw_json
				end,
				created_at = min(profiles.created_at, excluded.created_at)
		`);
		const upsertTweet = db.prepare(`
			insert into tweets (
				id, author_profile_id, text, created_at, is_replied, reply_to_id,
				like_count, media_count, entities_json, media_json, quoted_tweet_id
			) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			on conflict(id) do update set
				author_profile_id = excluded.author_profile_id,
				text = excluded.text,
				created_at = excluded.created_at,
				is_replied = max(tweets.is_replied, excluded.is_replied),
				reply_to_id = coalesce(tweets.reply_to_id, excluded.reply_to_id),
				like_count = excluded.like_count,
				media_count = max(tweets.media_count, excluded.media_count),
				entities_json = excluded.entities_json,
				media_json = case
					when excluded.media_json not in ('', '[]', 'null')
						then excluded.media_json
					else tweets.media_json
				end,
				quoted_tweet_id = coalesce(
					tweets.quoted_tweet_id,
					excluded.quoted_tweet_id
				)
		`);
		const upsertEdge = db.prepare(`
			insert into tweet_account_edges (
				account_id, tweet_id, kind, first_seen_at, last_seen_at, seen_count,
				source, raw_json, updated_at
			) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
			on conflict(account_id, tweet_id, kind) do update set
				first_seen_at = min(
					tweet_account_edges.first_seen_at,
					excluded.first_seen_at
				),
				last_seen_at = max(
					tweet_account_edges.last_seen_at,
					excluded.last_seen_at
				),
				seen_count = max(
					tweet_account_edges.seen_count,
					excluded.seen_count
				),
				source = coalesce(
					nullif(excluded.source, ''),
					tweet_account_edges.source
				),
				raw_json = case
					when excluded.raw_json not in ('', '{}', 'null')
						then excluded.raw_json
					else tweet_account_edges.raw_json
				end,
				updated_at = max(
					tweet_account_edges.updated_at,
					excluded.updated_at
				)
		`);
		const mergeLocalBookmarks = db.prepare(`
			insert into local_tweet_bookmarks (
				account_id, tweet_id, is_bookmarked, created_at, updated_at
			)
			select ?, tweet_id, is_bookmarked, created_at, updated_at
			from local_tweet_bookmarks
			where account_id = ?
			on conflict(account_id, tweet_id) do update set
				is_bookmarked = case
					when excluded.updated_at >= local_tweet_bookmarks.updated_at
						then excluded.is_bookmarked
					else local_tweet_bookmarks.is_bookmarked
				end,
				created_at = min(
					local_tweet_bookmarks.created_at,
					excluded.created_at
				),
				updated_at = max(
					local_tweet_bookmarks.updated_at,
					excluded.updated_at
				)
		`);
		const mergeTweetCollections = db.prepare(`
			insert into tweet_collections (
				account_id, tweet_id, kind, collected_at, source, raw_json, updated_at
			)
			select ?, tweet_id, kind, collected_at, source, raw_json, updated_at
			from tweet_collections
			where account_id = ?
			on conflict(account_id, tweet_id, kind) do update set
				collected_at = coalesce(
					tweet_collections.collected_at,
					excluded.collected_at
				),
				source = coalesce(
					nullif(excluded.source, ''),
					tweet_collections.source
				),
				raw_json = case
					when excluded.raw_json not in ('', '{}', 'null')
						then excluded.raw_json
					else tweet_collections.raw_json
				end,
				updated_at = max(
					tweet_collections.updated_at,
					excluded.updated_at
				)
		`);
		const twitter6551Config = getTwitter6551RuntimeConfig();
		const canonicalAccountId = twitter6551Config.failoverMode
			? twitter6551Config.accountId
			: "";
		const mappedAccountId = (accountId: string) =>
			canonicalAccountId || accountId;
		let canonicalHandle = canonicalAccountId
			? (
					db
						.prepare("select handle from accounts where id = ?")
						.get(canonicalAccountId) as { handle?: string } | undefined
				)?.handle
			: undefined;
		for (const row of batch.accounts) {
			let targetHandle = row.handle;
			if (canonicalAccountId) {
				if (canonicalHandle) {
					targetHandle = canonicalHandle;
				} else {
					const owner = db
						.prepare(
							"select id from accounts where lower(handle) = lower(?) limit 1",
						)
						.get(row.handle) as { id?: string } | undefined;
					if (owner?.id && owner.id !== canonicalAccountId) {
						targetHandle = `@birdclaw_${createHash("sha256")
							.update(canonicalAccountId)
							.digest("hex")
							.slice(0, 12)}`;
					}
					canonicalHandle = targetHandle;
				}
			}
			upsertAccount.run(
				mappedAccountId(row.id),
				row.name,
				targetHandle,
				row.externalUserId,
				row.transport,
				row.isDefault,
				row.createdAt,
			);
		}
		if (canonicalAccountId) {
			const mergeAccountIds = new Set(
				batch.accounts
					.map((account) => account.id)
					.filter((accountId) => accountId !== canonicalAccountId),
			);
			const legacyAccounts = db
				.prepare(
					`
					select id
					from accounts
					where transport = 'twitter6551' and id <> ?
					`,
				)
				.all(canonicalAccountId) as Array<{ id: string }>;
			for (const row of legacyAccounts) mergeAccountIds.add(row.id);
			for (const accountId of mergeAccountIds) {
				const legacyEdges = db
					.prepare(
						`
						select
							tweet_id as tweetId,
							kind,
							first_seen_at as firstSeenAt,
							last_seen_at as lastSeenAt,
							seen_count as seenCount,
							source,
							raw_json as rawJson,
							updated_at as updatedAt
						from tweet_account_edges
						where account_id = ?
						`,
					)
					.all(accountId) as Array<
					Omit<LocalCloudBridgeBatch["edges"][number], "accountId">
				>;
				for (const edge of legacyEdges) {
					upsertEdge.run(
						canonicalAccountId,
						edge.tweetId,
						edge.kind,
						edge.firstSeenAt,
						edge.lastSeenAt,
						edge.seenCount,
						edge.source,
						edge.rawJson,
						edge.updatedAt,
					);
				}
				db.prepare("delete from tweet_account_edges where account_id = ?").run(
					accountId,
				);
				mergeLocalBookmarks.run(canonicalAccountId, accountId);
				db.prepare(
					"delete from local_tweet_bookmarks where account_id = ?",
				).run(accountId);
				mergeTweetCollections.run(canonicalAccountId, accountId);
				db.prepare("delete from tweet_collections where account_id = ?").run(
					accountId,
				);
				db.prepare("update accounts set is_default = 0 where id = ?").run(
					accountId,
				);
				db.prepare(
					"delete from accounts where id = ? and transport = 'twitter6551'",
				).run(accountId);
			}
		}
		const profileIdMap = new Map<string, string>();
		for (const row of batch.profiles) {
			const existing = db
				.prepare(
					`select id
					 from profiles
					 where id = ? or lower(handle) = lower(?)
					 order by
					   case when id = ? then 0 else 1 end,
					   created_at desc,
					   id
					 limit 1`,
				)
				.get(row.id, row.handle, row.id) as { id?: string } | undefined;
			const targetProfileId = existing?.id ?? row.id;
			profileIdMap.set(row.id, targetProfileId);
			upsertProfile.run(
				targetProfileId,
				row.handle,
				row.displayName,
				row.bio,
				row.followersCount,
				row.followingCount,
				row.publicMetricsJson,
				row.avatarHue,
				row.avatarUrl,
				row.location,
				row.url,
				row.verifiedType,
				row.entitiesJson,
				row.rawJson,
				row.createdAt,
			);
		}
		for (const row of batch.tweets) {
			upsertTweet.run(
				row.id,
				profileIdMap.get(row.authorProfileId) ?? row.authorProfileId,
				row.text,
				row.createdAt,
				row.isReplied,
				row.replyToId,
				row.likeCount,
				row.mediaCount,
				row.entitiesJson,
				row.mediaJson,
				row.quotedTweetId,
			);
			replaceTweetFts(db, row.id, row.text);
		}
		for (const row of batch.edges) {
			upsertEdge.run(
				mappedAccountId(row.accountId),
				row.tweetId,
				row.kind,
				row.firstSeenAt,
				row.lastSeenAt,
				row.seenCount,
				row.source,
				row.rawJson,
				row.updatedAt,
			);
		}
		if (batch.xRemarkSnapshot) {
			db.prepare("delete from xremark_profile_notes").run();
			for (const annotation of batch.xRemarkSnapshot.annotations) {
				insertXRemarkAnnotation.run(
					annotation.identifier,
					annotation.handle,
					annotation.displayName,
					annotation.remark,
					annotation.description,
					JSON.stringify(annotation.tags),
					annotation.categoryName,
					annotation.sourceCreatedAt,
					annotation.sourceUpdatedAt,
					annotation.importedAt,
				);
			}
			replaceXRemarkState.run(
				batch.xRemarkSnapshot.backupId,
				batch.xRemarkSnapshot.backupTime,
				batch.xRemarkSnapshot.sourceVersion,
				batch.xRemarkSnapshot.importedAt,
				batch.xRemarkSnapshot.annotations.length,
			);
		}
		if (batch.purpose === "live" && batch.caughtUp) {
			mergeProfilePriorityRows(
				remapProfilePriorityRowsToDatabase(batch.profilePriorities, db),
				db,
			);
		}
		return {
			purpose: batch.purpose,
			caughtUp: batch.caughtUp,
			accounts: batch.accounts.length,
			profiles: batch.profiles.length,
			tweets: batch.tweets.length,
			edges: batch.edges.length,
			xRemarkAnnotations: batch.xRemarkSnapshot?.annotations.length ?? 0,
			profilePriorities:
				batch.purpose === "live" && batch.caughtUp
					? listProfilePriorityRows(db)
					: [],
			cursor: batch.cursor,
		};
	});
	return { ok: true as const, ...result };
}

export function isLocalCloudBridgeTokenConfigured() {
	return Boolean(process.env.BIRDCLAW_LOCAL_BRIDGE_TOKEN?.trim());
}

export function verifyLocalCloudBridgeToken(candidate: string) {
	const expected = process.env.BIRDCLAW_LOCAL_BRIDGE_TOKEN?.trim();
	if (!expected) return false;
	const left = Buffer.from(candidate);
	const right = Buffer.from(expected);
	return left.length === right.length && timingSafeEqual(left, right);
}

function validatedCloudBridgeUrl(value: string) {
	const url = new URL(value);
	const loopback =
		url.hostname === "localhost" ||
		url.hostname === "127.0.0.1" ||
		url.hostname === "::1";
	if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
		throw new Error("BirdClaw cloud bridge URL must use HTTPS");
	}
	url.pathname = "/api/integrations/local-bridge";
	url.search = "";
	url.hash = "";
	return url.toString();
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

export class LocalCloudBridgeClient {
	private timer: ReturnType<typeof setInterval> | null = null;
	private stopped = false;
	private running = false;
	private status: LocalCloudBridgeClientStatus = {
		enabled: true,
		running: false,
		lastSuccessAt: null,
		lastError: null,
		uploadedEdges: 0,
		backfillCompleted: false,
		backfillLastSuccessAt: null,
		backfillLastError: null,
		backfilledEdges: 0,
	};
	private readonly url: string;
	private readonly intervalSeconds: number;
	private readonly lookbackHours: number;
	private readonly batchSize: number;
	private readonly accountId: string | undefined;
	private readonly fetchImpl: typeof fetch;
	private readonly now: () => Date;

	constructor(private readonly options: LocalCloudBridgeClientOptions) {
		if (!options.token.trim()) {
			throw new Error("BirdClaw cloud bridge token is missing");
		}
		this.url = validatedCloudBridgeUrl(options.url);
		this.intervalSeconds = Math.max(
			15,
			options.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS,
		);
		this.lookbackHours = Math.max(
			1,
			options.lookbackHours ?? DEFAULT_LOOKBACK_HOURS,
		);
		this.batchSize = Math.max(
			1,
			Math.min(MAX_BATCH_SIZE, options.batchSize ?? DEFAULT_BATCH_SIZE),
		);
		this.accountId = options.accountId?.trim() || undefined;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.now = options.now ?? (() => new Date());
	}

	start() {
		if (this.stopped || this.timer) return;
		void this.runOnce();
		this.timer = setInterval(
			() => void this.runOnce(),
			this.intervalSeconds * 1000,
		);
	}

	stop() {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	getStatus() {
		return { ...this.status };
	}

	private async sendBatch(
		db: Database,
		cursor: LocalCloudBridgeCursor,
		purpose: z.infer<typeof bridgePurposeSchema>,
	) {
		let requestBatchSize = this.batchSize;
		let batch = buildLocalCloudBridgeBatch({
			cursor,
			purpose,
			lookbackHours: this.lookbackHours,
			limit: requestBatchSize,
			accountId: this.accountId,
			now: this.now(),
			db,
		});
		let requestBody = JSON.stringify(batch);
		while (
			Buffer.byteLength(requestBody) > MAX_CLIENT_BODY_BYTES &&
			requestBatchSize > 1
		) {
			requestBatchSize = Math.max(1, Math.floor(requestBatchSize / 2));
			batch = buildLocalCloudBridgeBatch({
				cursor,
				purpose,
				lookbackHours: this.lookbackHours,
				limit: requestBatchSize,
				accountId: this.accountId,
				now: this.now(),
				db,
			});
			requestBody = JSON.stringify(batch);
		}
		if (Buffer.byteLength(requestBody) > MAX_CLIENT_BODY_BYTES) {
			throw new Error("One local bridge record exceeds the safe request size");
		}
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		let response: Response;
		try {
			response = await this.fetchImpl(this.url, {
				method: "POST",
				headers: {
					authorization: `Bearer ${this.options.token}`,
					"content-type": "application/json",
				},
				body: requestBody,
				signal: controller.signal,
			});
		} finally {
			clearTimeout(timeout);
		}
		const payload = z
			.object({
				ok: z.boolean(),
				message: z.string().optional(),
				profilePriorities: z
					.array(bridgeProfilePrioritySchema)
					.max(50_000)
					.optional()
					.default([]),
			})
			.safeParse(await response.json().catch(() => null));
		if (!response.ok || !payload.success || !payload.data.ok) {
			throw new Error(
				(payload.success ? payload.data.message : undefined) ??
					`BirdClaw cloud bridge failed (${String(response.status)})`,
			);
		}
		if (payload.data.profilePriorities.length > 0) {
			await enqueueDatabaseWrite((writeDb) =>
				mergeProfilePriorityRows(
					remapProfilePriorityRowsToDatabase(
						payload.data.profilePriorities,
						writeDb,
					),
					writeDb,
				),
			);
		}
		return batch;
	}

	private async uploadLivePages() {
		let caughtUp = false;
		for (let page = 0; page < MAX_PAGES_PER_RUN && !this.stopped; page += 1) {
			const db = getNativeDb({ seedDemoData: false });
			const cursor = readBridgeCursor(
				db,
				this.url,
				this.lookbackHours,
				this.now(),
			);
			const batch = await this.sendBatch(db, cursor, "live");
			await enqueueDatabaseWrite((writeDb) =>
				writeBridgeCursor(writeDb, this.url, batch.cursor, this.now()),
			);
			this.status = {
				...this.status,
				lastSuccessAt: this.now().toISOString(),
				lastError: null,
				uploadedEdges: this.status.uploadedEdges + batch.edges.length,
			};
			caughtUp = batch.caughtUp;
			if (caughtUp) break;
		}
		return caughtUp;
	}

	private async uploadHistoryPages() {
		for (let page = 0; page < MAX_PAGES_PER_RUN && !this.stopped; page += 1) {
			const db = getNativeDb({ seedDemoData: false });
			const state = readBridgeHistoryState(db, this.url);
			if (state.completedAt) {
				this.status = {
					...this.status,
					backfillCompleted: true,
					backfillLastError: null,
				};
				return;
			}
			const batch = await this.sendBatch(db, state.cursor, "history");
			const completedAt = batch.caughtUp ? this.now().toISOString() : null;
			await enqueueDatabaseWrite((writeDb) =>
				writeBridgeHistoryState(
					writeDb,
					this.url,
					{
						version: 1,
						cursor: batch.cursor,
						completedAt,
					},
					this.now(),
				),
			);
			this.status = {
				...this.status,
				backfillCompleted: batch.caughtUp,
				backfillLastSuccessAt: this.now().toISOString(),
				backfillLastError: null,
				backfilledEdges: this.status.backfilledEdges + batch.edges.length,
			};
			if (batch.caughtUp) return;
		}
	}

	async runOnce() {
		if (this.stopped || this.running) return this.getStatus();
		if (this.options.isReady && !this.options.isReady()) {
			this.status = {
				...this.status,
				lastError:
					"Local Twitter collection is not fresh; cloud failover remains active",
			};
			return this.getStatus();
		}
		this.running = true;
		this.status = { ...this.status, running: true };
		try {
			const liveCaughtUp = await this.uploadLivePages();
			if (liveCaughtUp && !this.stopped) {
				try {
					await this.uploadHistoryPages();
				} catch (error) {
					this.status = {
						...this.status,
						backfillLastError: errorMessage(error),
					};
				}
			}
		} catch (error) {
			this.status = { ...this.status, lastError: errorMessage(error) };
		} finally {
			this.running = false;
			this.status = { ...this.status, running: false };
		}
		return this.getStatus();
	}
}

let activeClient: LocalCloudBridgeClient | null = null;

export function getLocalCloudBridgeClientStatus(): LocalCloudBridgeClientStatus {
	return (
		activeClient?.getStatus() ?? {
			enabled: false,
			running: false,
			lastSuccessAt: null,
			lastError: null,
			uploadedEdges: 0,
			backfillCompleted: false,
			backfillLastSuccessAt: null,
			backfillLastError: null,
			backfilledEdges: 0,
		}
	);
}

export function startLocalCloudBridgeClient() {
	const url = process.env.BIRDCLAW_CLOUD_BRIDGE_URL?.trim();
	const token = process.env.BIRDCLAW_CLOUD_BRIDGE_TOKEN?.trim();
	if (!url || !token) return null;
	if (activeClient) return activeClient;
	activeClient = new LocalCloudBridgeClient({
		url,
		token,
		intervalSeconds: positiveNumber(
			process.env.BIRDCLAW_CLOUD_BRIDGE_INTERVAL_SECONDS,
			DEFAULT_INTERVAL_SECONDS,
		),
		lookbackHours: positiveNumber(
			process.env.BIRDCLAW_CLOUD_BRIDGE_LOOKBACK_HOURS,
			DEFAULT_LOOKBACK_HOURS,
		),
		batchSize: positiveNumber(
			process.env.BIRDCLAW_CLOUD_BRIDGE_BATCH_SIZE,
			DEFAULT_BATCH_SIZE,
		),
		...(process.env.BIRDCLAW_LOCAL_COLLECTOR_ENABLED === "1"
			? { accountId: resolveLocalTwitterCollectorAccountId() }
			: {}),
		...(process.env.BIRDCLAW_LOCAL_COLLECTOR_ENABLED === "1"
			? { isReady: isLocalTwitterCollectorFresh }
			: {}),
	});
	activeClient.start();
	return activeClient;
}

export function stopLocalCloudBridgeClient() {
	activeClient?.stop();
	activeClient = null;
}
