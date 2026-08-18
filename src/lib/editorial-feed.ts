import { createHash } from "node:crypto";
import { z } from "zod";
import type { FeedItem, FeedItemKind, FeedSyncStatus } from "./api-contracts";
import { getNativeDb, getReadDb } from "./db";
import type { Database } from "./sqlite";
import { safeHttpUrl } from "./url-safety";

const TIGER_SOURCE = "tiger";
const TIGER_FLASH_API_URL =
	"https://stock-news.skytigris.cn/v2/live/timeline?edition=fundamental&onlyImportant=true&lang=zh_CN&type=us";
const TIGER_ARTICLE_API_URL =
	"https://stock-news.laohu8.com/v2/highlight/list?lang=zh_CN";
const TIGER_FLASH_URL =
	"https://www.laohu8.com/news/breaking?onlyImportant=true&market=us";
const TIGER_ARTICLE_URL = "https://www.laohu8.com/news";
const TIGER_FLASH_FALLBACK_URL = TIGER_FLASH_URL;
const TIGER_ARTICLE_FALLBACK_URL = TIGER_ARTICLE_URL;
const MAX_HTML_BYTES = 2_000_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_TITLE_LENGTH = 4_000;
const MAX_SUMMARY_LENGTH = 500;
const FLASH_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_FLASH_PAGES = 40;
const MAX_ARTICLE_PAGES = 10;
const TIGER_ALLOWED_HOSTS = new Set([
	"www.laohu8.com",
	"stock-news.laohu8.com",
	"stock-news.skytigris.cn",
]);

interface FeedItemRow extends Record<string, unknown> {
	id: string;
	source: string;
	external_id: string;
	kind: string;
	title: string;
	summary: string;
	url: string;
	publisher: string;
	published_at: string;
	market: string;
	language: string;
	symbols_json: string;
	image_url: string | null;
	is_important: number;
	updated_at: string;
}

interface FeedSyncRow extends Record<string, unknown> {
	source: string;
	kind: string;
	status: string;
	last_started_at: string | null;
	last_success_at: string | null;
	last_item_at: string | null;
	last_error: string | null;
	updated_at: string;
}

interface NormalizedFeedItem extends FeedItem {
	contentHash: string;
}

const tigerFlashItemSchema = z.looseObject({
	id: z.union([z.string(), z.number()]),
	content: z.string(),
	isHighlight: z.union([z.number(), z.boolean()]),
	pubTime: z.union([z.number(), z.string()]),
	media: z.string().optional().default("老虎资讯"),
	symbols: z.array(z.string()).optional().default([]),
});

const tigerFlashPageSchema = z.looseObject({
	data: z.looseObject({
		breakingNews: z.looseObject({
			listData: z.array(tigerFlashItemSchema),
			market: z.literal("us"),
			onlyImportant: z.literal(true),
		}),
	}),
});

const tigerArticleItemSchema = z.looseObject({
	id: z.union([z.string(), z.number()]),
	title: z.string(),
	url: z.string().optional().default(""),
	share: z.string().optional().default(""),
	media: z.string().optional().default("老虎资讯"),
	pubTime: z.string().optional().default(""),
	pubTimestamp: z.union([z.number(), z.string()]),
	summary: z.string().optional().default(""),
	market: z.string().optional().default(""),
	language: z.string().optional().default("zh"),
	symbols: z.array(z.string()).optional().default([]),
	thumbnail: z.string().optional().default(""),
	thumbnails: z.array(z.string()).optional().default([]),
	news_tag: z.string().optional(),
	rights: z.unknown().nullable().optional(),
	isHighRisk: z.boolean().optional(),
});

const tigerArticlePageSchema = z.looseObject({
	data: z.looseObject({
		topNews: z.looseObject({
			listData: z.array(tigerArticleItemSchema),
		}),
	}),
});

const tigerFlashApiSchema = z.looseObject({
	items: z.array(tigerFlashItemSchema),
	code: z.union([z.string(), z.number()]),
	status: z.union([z.string(), z.number()]),
});

const tigerArticleApiSchema = z.looseObject({
	items: z.array(tigerArticleItemSchema),
	code: z.union([z.string(), z.number()]),
	status: z.union([z.string(), z.number()]),
});

function parseJsonArray(value: string) {
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed)
			? parsed.filter((item): item is string => typeof item === "string")
			: [];
	} catch {
		return [];
	}
}

function rowToFeedItem(row: FeedItemRow): FeedItem {
	return {
		id: row.id,
		source: row.source,
		externalId: row.external_id,
		kind: row.kind === "flash" ? "flash" : "article",
		title: row.title,
		summary: row.summary,
		url: row.url,
		publisher: row.publisher,
		publishedAt: row.published_at,
		market: row.market,
		language: row.language,
		symbols: parseJsonArray(row.symbols_json),
		imageUrl: row.image_url,
		isImportant: Boolean(row.is_important),
		updatedAt: row.updated_at,
	};
}

function rowToSyncStatus(row: FeedSyncRow): FeedSyncStatus {
	const state =
		row.status === "syncing" || row.status === "ready" || row.status === "error"
			? row.status
			: "idle";
	return {
		source: row.source,
		kind: row.kind === "flash" ? "flash" : "article",
		state,
		lastStartedAt: row.last_started_at,
		lastSuccessAt: row.last_success_at,
		lastItemAt: row.last_item_at,
		error: row.last_error,
		updatedAt: row.updated_at,
	};
}

function emptySyncStatus(kind: FeedItemKind): FeedSyncStatus {
	return {
		source: TIGER_SOURCE,
		kind,
		state: "idle",
		lastStartedAt: null,
		lastSuccessAt: null,
		lastItemAt: null,
		error: null,
		updatedAt: new Date(0).toISOString(),
	};
}

export function listFeedItems(
	options: {
		kind: FeedItemKind;
		limit?: number;
		offset?: number;
		since?: string;
		until?: string;
	},
	db = getReadDb(),
): FeedItem[] {
	const limit = Math.max(1, Math.min(500, Math.trunc(options.limit ?? 100)));
	const offset = Math.max(0, Math.trunc(options.offset ?? 0));
	const filters = ["kind = ?"];
	const parameters: Array<string | number> = [options.kind];
	if (options.kind === "flash") {
		filters.push("is_important = 1", "lower(market) = 'us'");
	}
	if (options.since) {
		filters.push("published_at >= ?");
		parameters.push(options.since);
	}
	if (options.until) {
		filters.push("published_at < ?");
		parameters.push(options.until);
	}
	parameters.push(limit, offset);
	const rows = db
		.prepare(
			`select id, source, external_id, kind, title, summary, url, publisher,
			        published_at, market, language, symbols_json, image_url,
			        is_important, updated_at
			 from feed_items
			 where ${filters.join(" and ")}
			 order by published_at desc, id desc
			 limit ? offset ?`,
		)
		.all(...parameters) as FeedItemRow[];
	return rows.map(rowToFeedItem);
}

export function countFeedItems(
	options: { kind?: FeedItemKind } = {},
	db = getReadDb(),
) {
	const row = options.kind
		? (db
				.prepare(
					`select count(*) as count from feed_items
					 where kind = ?${options.kind === "flash" ? " and is_important = 1 and lower(market) = 'us'" : ""}`,
				)
				.get(options.kind) as { count: number })
		: (db
				.prepare(
					`select count(*) as count from feed_items
					 where kind != 'flash'
					    or (is_important = 1 and lower(market) = 'us')`,
				)
				.get() as {
				count: number;
			});
	return Number(row.count);
}

export function getFeedSyncStatus(
	kind: FeedItemKind,
	db = getReadDb(),
): FeedSyncStatus {
	const row = db
		.prepare("select * from feed_sync_state where source = ? and kind = ?")
		.get(TIGER_SOURCE, kind) as FeedSyncRow | undefined;
	return row ? rowToSyncStatus(row) : emptySyncStatus(kind);
}

function decodeHtmlEntities(value: string) {
	const named: Record<string, string> = {
		amp: "&",
		apos: "'",
		gt: ">",
		lt: "<",
		quot: '"',
	};
	return value.replace(
		/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi,
		(
			_match,
			decimal: string | undefined,
			hex: string | undefined,
			name: string,
		) => {
			if (decimal) return String.fromCodePoint(Number(decimal));
			if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
			return named[name.toLowerCase()] ?? _match;
		},
	);
}

function extractAppData(html: string) {
	const match =
		/<textarea\b[^>]*\bid=(["'])__APP_DATA__\1[^>]*>([\s\S]*?)<\/textarea>/i.exec(
			html,
		);
	if (!match?.[2]) throw new Error("Tiger feed page did not include app data");
	try {
		return JSON.parse(decodeHtmlEntities(match[2])) as unknown;
	} catch {
		throw new Error("Tiger feed page returned invalid app data");
	}
}

function cleanText(value: string, maxLength: number) {
	return decodeHtmlEntities(value)
		.replaceAll(/<[^>]*>/g, " ")
		.replaceAll(/\s+/g, " ")
		.trim()
		.slice(0, maxLength);
}

function normalizedSymbols(value: string[]) {
	return [
		...new Set(
			value
				.map((symbol) => symbol.trim())
				.filter(Boolean)
				.slice(0, 100),
		),
	];
}

function timestampFrom(
	value: string | number,
	unit: "seconds" | "milliseconds",
) {
	const parsed = typeof value === "number" ? value : Number(value);
	const milliseconds = unit === "seconds" ? parsed * 1_000 : parsed;
	const date = new Date(milliseconds);
	if (!Number.isFinite(milliseconds) || Number.isNaN(date.getTime())) {
		throw new Error("Tiger feed item has an invalid publication time");
	}
	return date.toISOString();
}

function itemHash(item: Omit<NormalizedFeedItem, "contentHash" | "updatedAt">) {
	return createHash("sha256").update(JSON.stringify(item)).digest("hex");
}

function normalizeFlashItems(appData: unknown, updatedAt: string) {
	const api = tigerFlashApiSchema.safeParse(appData);
	const items = api.success
		? api.data.items
		: tigerFlashPageSchema.parse(appData).data.breakingNews.listData;
	if (api.success && String(api.data.status) !== "200") {
		throw new Error("Tiger flash feed returned a failure status");
	}
	return items
		.filter(
			(item) => item.isHighlight === true || Number(item.isHighlight) === 1,
		)
		.map((item): NormalizedFeedItem => {
			const externalId = String(item.id);
			const title = cleanText(item.content, MAX_TITLE_LENGTH);
			const base = {
				id: `${TIGER_SOURCE}:flash:${externalId}`,
				source: TIGER_SOURCE,
				externalId,
				kind: "flash" as const,
				title,
				summary: "",
				url: TIGER_FLASH_FALLBACK_URL,
				publisher: cleanText(item.media, 200) || "老虎资讯",
				publishedAt: timestampFrom(item.pubTime, "milliseconds"),
				market: "us",
				language: "zh-CN",
				symbols: normalizedSymbols(item.symbols),
				imageUrl: null,
				isImportant: true,
			};
			return { ...base, contentHash: itemHash(base), updatedAt };
		});
}

function normalizeArticleItems(appData: unknown, updatedAt: string) {
	const api = tigerArticleApiSchema.safeParse(appData);
	const items = api.success
		? api.data.items
		: tigerArticlePageSchema.parse(appData).data.topNews.listData;
	if (api.success && String(api.data.status) !== "200") {
		throw new Error("Tiger article feed returned a failure status");
	}
	return items.map((item): NormalizedFeedItem => {
		const externalId = String(item.id);
		const canonicalUrl = `https://www.laohu8.com/news/${encodeURIComponent(externalId)}`;
		const language = item.language.toLowerCase().startsWith("zh")
			? "zh-CN"
			: item.language || "zh-CN";
		const base = {
			id: `${TIGER_SOURCE}:article:${externalId}`,
			source: TIGER_SOURCE,
			externalId,
			kind: "article" as const,
			title: cleanText(item.title, MAX_TITLE_LENGTH),
			summary:
				item.rights === null &&
				item.isHighRisk === false &&
				typeof item.news_tag === "string" &&
				!item.news_tag
					.toLowerCase()
					.split(",")
					.some((tag) => tag.trim() === "analysis")
					? cleanText(item.summary, MAX_SUMMARY_LENGTH)
					: "",
			url: safeHttpUrl(canonicalUrl) ?? TIGER_ARTICLE_FALLBACK_URL,
			publisher: cleanText(item.media, 200) || "老虎资讯",
			publishedAt: timestampFrom(item.pubTimestamp, "seconds"),
			market: cleanText(item.market, 40),
			language,
			symbols: normalizedSymbols(item.symbols),
			imageUrl: null,
			isImportant: false,
		};
		return { ...base, contentHash: itemHash(base), updatedAt };
	});
}

async function fetchFeedPayload(
	url: string,
	fetchImpl: typeof fetch,
	signal?: AbortSignal,
) {
	const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
	const response = await fetchImpl(url, {
		headers: {
			accept: "application/json,text/html,application/xhtml+xml",
			"user-agent": "Mozilla/5.0 BirdClaw personal feed reader",
		},
		redirect: "follow",
		signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
	});
	const responseUrl = new URL(response.url || url);
	if (
		responseUrl.protocol !== "https:" ||
		!TIGER_ALLOWED_HOSTS.has(responseUrl.hostname)
	) {
		throw new Error("Tiger feed redirected outside the allowed source hosts");
	}
	if (!response.ok) {
		throw new Error(
			`Tiger feed request failed with HTTP ${String(response.status)}`,
		);
	}
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > MAX_HTML_BYTES) {
		throw new Error("Tiger feed response was too large");
	}
	const body = await response.text();
	if (Buffer.byteLength(body, "utf8") > MAX_HTML_BYTES) {
		throw new Error("Tiger feed response was too large");
	}
	if (response.headers.get("content-type")?.includes("application/json")) {
		try {
			return JSON.parse(body) as unknown;
		} catch {
			throw new Error("Tiger feed endpoint returned invalid JSON");
		}
	}
	return extractAppData(body);
}

function writeSyncState(
	db: Database,
	options: {
		kind: FeedItemKind;
		status: FeedSyncStatus["state"];
		now: string;
		lastSuccessAt?: string | null;
		lastItemAt?: string | null;
		error?: string | null;
	},
) {
	db.prepare(
		`insert into feed_sync_state (
		   source, kind, status, last_started_at, last_success_at, last_item_at,
		   last_error, updated_at
		 ) values (?, ?, ?, ?, ?, ?, ?, ?)
		 on conflict(source, kind) do update set
		   status = excluded.status,
		   last_started_at = case
		     when excluded.status = 'syncing' then excluded.last_started_at
		     else feed_sync_state.last_started_at
		   end,
		   last_success_at = coalesce(excluded.last_success_at, feed_sync_state.last_success_at),
		   last_item_at = case
		     when excluded.last_item_at is null then feed_sync_state.last_item_at
		     when feed_sync_state.last_item_at is null then excluded.last_item_at
		     else max(feed_sync_state.last_item_at, excluded.last_item_at)
		   end,
		   last_error = excluded.last_error,
		   updated_at = excluded.updated_at`,
	).run(
		TIGER_SOURCE,
		options.kind,
		options.status,
		options.status === "syncing" ? options.now : null,
		options.lastSuccessAt ?? null,
		options.lastItemAt ?? null,
		options.error ?? null,
		options.now,
	);
}

function upsertFeedItems(items: NormalizedFeedItem[], db: Database) {
	const insert = db.prepare(
		`insert into feed_items (
		   id, source, external_id, kind, title, summary, url, publisher,
		   published_at, market, language, symbols_json, image_url, is_important,
		   content_hash, first_seen_at, updated_at
		 ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 on conflict(id) do update set
		   title = excluded.title,
		   summary = excluded.summary,
		   url = excluded.url,
		   publisher = excluded.publisher,
		   published_at = excluded.published_at,
		   market = excluded.market,
		   language = excluded.language,
		   symbols_json = excluded.symbols_json,
		   image_url = excluded.image_url,
		   is_important = excluded.is_important,
		   content_hash = excluded.content_hash,
		   updated_at = excluded.updated_at
		 where excluded.content_hash <> feed_items.content_hash`,
	);
	let changed = 0;
	db.transaction(() => {
		for (const item of items) {
			changed += insert.run(
				item.id,
				item.source,
				item.externalId,
				item.kind,
				item.title,
				item.summary,
				item.url,
				item.publisher,
				item.publishedAt,
				item.market,
				item.language,
				JSON.stringify(item.symbols),
				item.imageUrl,
				item.isImportant ? 1 : 0,
				item.contentHash,
				item.updatedAt,
				item.updatedAt,
			).changes;
		}
	})();
	return changed;
}

const inFlightSyncs = new Map<FeedItemKind, Promise<FeedSyncResult>>();

export interface FeedSyncResult {
	kind: FeedItemKind;
	seen: number;
	changed: number;
}

function knownExternalIds(kind: FeedItemKind, db: Database) {
	return new Set(
		(
			db
				.prepare(
					`select external_id from feed_items
					 where source = ? and kind = ?
					 ${kind === "flash" ? "and lower(market) = 'us'" : ""}`,
				)
				.all(TIGER_SOURCE, kind) as Array<{ external_id: string }>
		).map((row) => row.external_id),
	);
}

async function fetchTigerPage(options: {
	kind: FeedItemKind;
	page: number;
	flashCursor?: string;
	fetchImpl: typeof fetch;
	signal?: AbortSignal;
}) {
	const directUrl = new URL(
		options.kind === "flash" ? TIGER_FLASH_API_URL : TIGER_ARTICLE_API_URL,
	);
	if (options.kind === "flash" && options.flashCursor) {
		directUrl.searchParams.set("t", options.flashCursor);
	}
	if (options.kind === "article") {
		directUrl.searchParams.set("pageCount", String(options.page));
	}
	try {
		return await fetchFeedPayload(
			directUrl.toString(),
			options.fetchImpl,
			options.signal,
		);
	} catch (error) {
		if (options.page !== 1) throw error;
		return fetchFeedPayload(
			options.kind === "flash" ? TIGER_FLASH_URL : TIGER_ARTICLE_URL,
			options.fetchImpl,
			options.signal,
		);
	}
}

export function syncTigerFeed(
	kind: FeedItemKind,
	options: {
		fetchImpl?: typeof fetch;
		now?: () => Date;
		signal?: AbortSignal;
		initialArticlePages?: number;
	} = {},
): Promise<FeedSyncResult> {
	const existing = inFlightSyncs.get(kind);
	if (existing) return existing;
	const run = (async () => {
		const db = getNativeDb();
		const now = options.now ?? (() => new Date());
		const startedAt = now().toISOString();
		writeSyncState(db, { kind, status: "syncing", now: startedAt });
		try {
			const fetchImpl = options.fetchImpl ?? fetch;
			const knownIds = knownExternalIds(kind, db);
			const initialArticlePages = Math.max(
				1,
				Math.min(MAX_ARTICLE_PAGES, options.initialArticlePages ?? 3),
			);
			const maxPages =
				kind === "flash"
					? MAX_FLASH_PAGES
					: knownIds.size > 0
						? MAX_ARTICLE_PAGES
						: initialArticlePages;
			const flashCutoff = startedAt
				? Date.parse(startedAt) - FLASH_LOOKBACK_MS
				: Date.now() - FLASH_LOOKBACK_MS;
			const items: NormalizedFeedItem[] = [];
			let flashCursor: string | undefined;
			for (let page = 1; page <= maxPages; page += 1) {
				const payload = await fetchTigerPage({
					kind,
					page,
					...(flashCursor ? { flashCursor } : {}),
					fetchImpl,
					...(options.signal ? { signal: options.signal } : {}),
				});
				const updatedAt = now().toISOString();
				const pageItems =
					kind === "flash"
						? normalizeFlashItems(payload, updatedAt)
						: normalizeArticleItems(payload, updatedAt);
				if (pageItems.length === 0) break;
				items.push(...pageItems);

				const reachedKnownItem = pageItems.some((item) =>
					knownIds.has(item.externalId),
				);
				if (knownIds.size > 0 && reachedKnownItem) break;

				if (kind === "flash") {
					const oldest = pageItems.reduce(
						(value, item) =>
							item.publishedAt < value ? item.publishedAt : value,
						pageItems[0]?.publishedAt ?? startedAt,
					);
					if (Date.parse(oldest) <= flashCutoff) break;
					const nextCursor = String(Date.parse(oldest));
					if (nextCursor === flashCursor) break;
					flashCursor = nextCursor;
				}
			}
			const uniqueItems = [
				...new Map(items.map((item) => [item.id, item])).values(),
			];
			const changed = upsertFeedItems(uniqueItems, db);
			const finishedAt = now().toISOString();
			const lastItemAt = uniqueItems.reduce<string | null>(
				(latest, item) =>
					!latest || item.publishedAt > latest ? item.publishedAt : latest,
				null,
			);
			writeSyncState(db, {
				kind,
				status: "ready",
				now: finishedAt,
				lastSuccessAt: finishedAt,
				lastItemAt,
				error: null,
			});
			return { kind, seen: uniqueItems.length, changed };
		} catch (error) {
			const failedAt = now().toISOString();
			const message = (error instanceof Error ? error.message : String(error))
				.replaceAll(/https?:\/\/\S+/g, "Tiger feed endpoint")
				.slice(0, 500);
			writeSyncState(db, {
				kind,
				status: "error",
				now: failedAt,
				error: message || "Tiger feed sync failed",
			});
			throw error;
		}
	})();
	inFlightSyncs.set(kind, run);
	const cleanup = () => {
		if (inFlightSyncs.get(kind) === run) inFlightSyncs.delete(kind);
	};
	void run.then(cleanup, cleanup);
	return run;
}

export const __test__ = {
	decodeHtmlEntities,
	extractAppData,
	normalizeArticleItems,
	normalizeFlashItems,
	rowToFeedItem,
};
