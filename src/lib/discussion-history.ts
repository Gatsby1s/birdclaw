import { randomUUID } from "node:crypto";
import { getNativeDb, getReadDb } from "./db";
import type { DiscussDateRange } from "./discuss-date-range";
import type {
	SearchDiscussionOptions,
	SearchDiscussionRunResult,
} from "./search-discussion";
import type { Database } from "./sqlite";

export interface DiscussionHistoryMetadata {
	id: string;
	title: string;
	summary: string;
	query: string;
	question?: string;
	account?: string;
	source: string;
	mode: string;
	range: DiscussDateRange;
	since?: string;
	until?: string;
	includeDms: boolean;
	originalsOnly: boolean;
	hideLowQuality: boolean;
	themeTitles: string[];
	sourceCount: number;
	dmCount: number;
	createdAt: string;
	updatedAt: string;
	parentId: string | null;
	pinned: boolean;
	versionCount: number;
}

export interface DiscussionHistoryDetail {
	metadata: DiscussionHistoryMetadata;
	result: SearchDiscussionRunResult;
}

interface DiscussionHistoryRow extends Record<string, unknown> {
	id: string;
	root_id: string;
	parent_id: string | null;
	title: string;
	summary: string;
	query: string;
	question: string | null;
	account: string | null;
	source: string;
	mode: string;
	range: string;
	since: string | null;
	until: string | null;
	include_dms: number;
	originals_only: number;
	hide_low_quality: number;
	model: string;
	reasoning_effort: string;
	service_tier: string;
	context_hash: string;
	counts_json: string;
	discussion_json: string;
	markdown: string;
	tweets_json: string;
	dms_json: string;
	live_search_json: string | null;
	created_at: string;
	updated_at: string;
	pinned_at: string | null;
	version_count: number;
}

interface SaveDiscussionHistoryInput {
	cacheKey: string;
	options: SearchDiscussionOptions;
	result: SearchDiscussionRunResult;
}

const HISTORY_SELECT = `
  select
    history.*,
    (
      select count(*)
      from discussion_history as version
      where version.root_id = history.root_id
        and version.deleted_at is null
    ) as version_count
  from discussion_history as history
`;

function parseJson<T>(value: string, fallback: T): T {
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function parseRange(value: string): DiscussDateRange {
	return value === "today" ||
		value === "24h" ||
		value === "yesterday" ||
		value === "week" ||
		value === "custom"
		? value
		: "all";
}

function metadataFromRow(row: DiscussionHistoryRow): DiscussionHistoryMetadata {
	const discussion = parseJson<SearchDiscussionRunResult["discussion"] | null>(
		row.discussion_json,
		null,
	);
	const tweets = parseJson<SearchDiscussionRunResult["context"]["tweets"]>(
		row.tweets_json,
		[],
	);
	const dms = parseJson<SearchDiscussionRunResult["context"]["dms"]>(
		row.dms_json,
		[],
	);
	return {
		id: row.id,
		title: row.title,
		summary: row.summary,
		query: row.query,
		...(row.question ? { question: row.question } : {}),
		...(row.account ? { account: row.account } : {}),
		source: row.source,
		mode: row.mode,
		range: parseRange(row.range),
		...(row.since ? { since: row.since } : {}),
		...(row.until ? { until: row.until } : {}),
		includeDms: Boolean(row.include_dms),
		originalsOnly: Boolean(row.originals_only),
		hideLowQuality: Boolean(row.hide_low_quality),
		themeTitles: discussion?.themes.map((theme) => theme.title) ?? [],
		sourceCount: tweets.length,
		dmCount: dms.length,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		parentId: row.parent_id,
		pinned: row.pinned_at !== null,
		versionCount: Number(row.version_count),
	};
}

function detailFromRow(row: DiscussionHistoryRow): DiscussionHistoryDetail {
	const metadata = metadataFromRow(row);
	const tweets = parseJson<SearchDiscussionRunResult["context"]["tweets"]>(
		row.tweets_json,
		[],
	);
	const dms = parseJson<SearchDiscussionRunResult["context"]["dms"]>(
		row.dms_json,
		[],
	);
	const counts = parseJson<SearchDiscussionRunResult["context"]["counts"]>(
		row.counts_json,
		{
			search: 0,
			home: 0,
			mentions: 0,
			authored: 0,
			likes: 0,
			bookmarks: 0,
			dms: 0,
		},
	);
	const liveSearch = row.live_search_json
		? parseJson<SearchDiscussionRunResult["context"]["liveSearch"]>(
				row.live_search_json,
				undefined,
			)
		: undefined;
	return {
		metadata,
		result: {
			context: {
				query: row.query,
				...(row.question ? { question: row.question } : {}),
				...(row.account ? { account: row.account } : {}),
				source: row.source as SearchDiscussionRunResult["context"]["source"],
				...(row.since ? { since: row.since } : {}),
				...(row.until ? { until: row.until } : {}),
				includeDms: Boolean(row.include_dms),
				counts,
				tweets,
				dms,
				...(liveSearch ? { liveSearch } : {}),
				hash: row.context_hash,
			},
			discussion: parseJson<SearchDiscussionRunResult["discussion"]>(
				row.discussion_json,
				{
					title: row.title,
					summary: row.summary,
					themes: [],
					tensions: [],
					followUps: [],
					sourceTweetIds: [],
					sourceDmConversationIds: [],
				},
			),
			markdown: row.markdown,
			model: row.model,
			reasoningEffort: row.reasoning_effort,
			serviceTier: row.service_tier,
			cached: true,
			updatedAt: row.created_at,
			historyId: row.id,
		},
	};
}

function referenceKeys(value: string, prefix: "tweet" | "dm") {
	const trimmed = value.trim();
	const withoutPrefix = trimmed.replace(new RegExp(`^${prefix}[_:]`, "i"), "");
	return [
		trimmed,
		withoutPrefix,
		`${prefix}_${withoutPrefix}`,
		`${prefix}:${withoutPrefix}`,
	].map((key) => key.toLowerCase());
}

function referencedItems<T extends { id: string }>(
	items: T[],
	prefix: "tweet" | "dm",
	structuredIds: string[],
	markdown: string,
) {
	const lookup = new Map<string, T>();
	for (const item of items) {
		for (const key of referenceKeys(item.id, prefix)) lookup.set(key, item);
	}
	const ids = new Set(structuredIds.map((id) => id.trim()).filter(Boolean));
	for (const citation of markdown.matchAll(/[（(]([^()（）]+)[）)]/g)) {
		for (const token of (citation[1] ?? "").split(/[\s,，、;；]+/)) {
			const cleaned = token.trim().replace(/^[`'"]+|[`'".]+$/g, "");
			if (cleaned) ids.add(cleaned);
		}
	}
	const selected = new Map<string, T>();
	for (const id of ids) {
		for (const key of referenceKeys(id, prefix)) {
			const item = lookup.get(key);
			if (item) {
				selected.set(item.id, item);
				break;
			}
		}
	}
	return items.filter((item) => selected.has(item.id));
}

function compactResultContext(result: SearchDiscussionRunResult) {
	const themeTweetIds = result.discussion.themes.flatMap(
		(theme) => theme.tweetIds,
	);
	const themeDmIds = result.discussion.themes.flatMap(
		(theme) => theme.dmConversationIds,
	);
	const tweets = referencedItems(
		result.context.tweets,
		"tweet",
		[...result.discussion.sourceTweetIds, ...themeTweetIds],
		result.markdown,
	);
	const dms = referencedItems(
		result.context.dms,
		"dm",
		[...result.discussion.sourceDmConversationIds, ...themeDmIds],
		result.markdown,
	);
	const citedTweetIds = new Set(tweets.map((tweet) => tweet.id));
	const liveSearch =
		result.context.liveSearch?.ok === true
			? {
					...result.context.liveSearch,
					tweetIds: result.context.liveSearch.tweetIds.filter((id) =>
						citedTweetIds.has(id),
					),
				}
			: result.context.liveSearch;
	return { tweets, dms, liveSearch };
}

function rowById(id: string, db: Database) {
	return db
		.prepare(
			`${HISTORY_SELECT} where history.id = ? and history.deleted_at is null`,
		)
		.get(id) as DiscussionHistoryRow | undefined;
}

export function listDiscussionHistory(
	options: { limit?: number } = {},
	db = getReadDb(),
) {
	const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 50)));
	const rows = db
		.prepare(
			`${HISTORY_SELECT}
       where history.deleted_at is null
         and history.rowid = (
           select version.rowid
           from discussion_history as version
           where version.root_id = history.root_id
             and version.deleted_at is null
           order by version.created_at desc, version.rowid desc
           limit 1
         )
       order by history.pinned_at desc, history.created_at desc
       limit ?`,
		)
		.all(limit) as DiscussionHistoryRow[];
	return rows.map(metadataFromRow);
}

export function getDiscussionHistory(id: string, db = getReadDb()) {
	const row = rowById(id, db);
	return row ? detailFromRow(row) : null;
}

export function findDiscussionHistoryIdByCacheKey(
	cacheKey: string,
	db = getReadDb(),
) {
	const row = db
		.prepare(
			`select id
       from discussion_history
       where cache_key = ? and deleted_at is null
       order by created_at desc
       limit 1`,
		)
		.get(cacheKey) as { id: string } | undefined;
	return row?.id ?? null;
}

export function saveDiscussionHistory(
	input: SaveDiscussionHistoryInput,
	db = getNativeDb(),
) {
	const id = randomUUID();
	const parent = input.options.parentHistoryId
		? (db
				.prepare(
					"select id, root_id, pinned_at from discussion_history where id = ? and deleted_at is null",
				)
				.get(input.options.parentHistoryId) as
				| { id: string; root_id: string; pinned_at: string | null }
				| undefined)
		: undefined;
	const compact = compactResultContext(input.result);
	const createdAt = input.result.updatedAt || new Date().toISOString();
	db.prepare(
		`insert into discussion_history (
       id, root_id, parent_id, cache_key, title, summary, query, question,
		account, source, mode, range, since, until, include_dms, originals_only,
       hide_low_quality, model, reasoning_effort, service_tier, context_hash,
       counts_json, discussion_json, markdown, tweets_json, dms_json,
		live_search_json, created_at, updated_at, pinned_at
	 ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		id,
		parent?.root_id ?? id,
		parent?.id ?? null,
		input.cacheKey,
		input.result.discussion.title,
		input.result.discussion.summary,
		input.result.context.query,
		input.result.context.question ?? null,
		input.result.context.account ?? null,
		input.result.context.source,
		input.options.mode ?? "auto",
		input.options.range ?? "all",
		input.result.context.since ?? null,
		input.result.context.until ?? null,
		input.result.context.includeDms ? 1 : 0,
		input.options.originalsOnly ? 1 : 0,
		input.options.hideLowQuality ? 1 : 0,
		input.result.model,
		input.result.reasoningEffort,
		input.result.serviceTier,
		input.result.context.hash,
		JSON.stringify(input.result.context.counts),
		JSON.stringify(input.result.discussion),
		input.result.markdown,
		JSON.stringify(compact.tweets),
		JSON.stringify(compact.dms),
		compact.liveSearch ? JSON.stringify(compact.liveSearch) : null,
		createdAt,
		createdAt,
		parent?.pinned_at ?? null,
	);
	return id;
}

export function reuseOrSaveDiscussionHistory(
	input: SaveDiscussionHistoryInput,
	db = getNativeDb(),
) {
	return db.transaction(() => {
		return (
			findDiscussionHistoryIdByCacheKey(input.cacheKey, db) ??
			saveDiscussionHistory(input, db)
		);
	})();
}

export function deleteDiscussionHistory(id: string, db = getNativeDb()) {
	const now = new Date().toISOString();
	return (
		db
			.prepare(
				`update discussion_history
         set deleted_at = ?, updated_at = ?
         where root_id = (
           select root_id from discussion_history where id = ? and deleted_at is null
         ) and deleted_at is null`,
			)
			.run(now, now, id).changes > 0
	);
}

export function updateDiscussionHistory(
	id: string,
	patch: { title?: string; pinned?: boolean },
	db = getNativeDb(),
) {
	const current = rowById(id, db);
	if (!current) return null;
	const now = new Date().toISOString();
	const title = patch.title?.trim() || current.title;
	const pinnedAt =
		patch.pinned === undefined ? current.pinned_at : patch.pinned ? now : null;
	db.transaction(() => {
		db.prepare(
			"update discussion_history set title = ?, updated_at = ? where id = ?",
		).run(title, now, id);
		if (patch.pinned !== undefined) {
			db.prepare(
				"update discussion_history set pinned_at = ?, updated_at = ? where root_id = ?",
			).run(pinnedAt, now, current.root_id);
		}
	})();
	const updated = rowById(id, db);
	return updated ? metadataFromRow(updated) : null;
}
