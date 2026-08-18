import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { getBirdclawPaths } from "./config";
import { getNativeDb, getReadDb } from "./db";
import {
	streamPeriodDigest,
	type PeriodDigestRunResult,
} from "./period-digest";
import { redactProviderError } from "./openai-response-runtime";
import type { Database } from "./sqlite";

export type WeeklyDigestHistoryStatus = "pending" | "ready" | "failed";
export const CURRENT_WEEKLY_DIGEST_FORMAT_VERSION = 3;

export interface WeeklyDigestHistoryMetadata {
	id: string;
	kind: "weekly";
	date: string;
	endDate: string;
	timezone: string;
	status: WeeklyDigestHistoryStatus;
	title: string;
	summary: string;
	counts: PeriodDigestRunResult["context"]["counts"];
	provider?: string;
	model?: string;
	attemptCount: number;
	formatVersion: number;
	error?: string;
	createdAt: string;
	updatedAt: string;
	finishedAt?: string;
	pdfAvailable: boolean;
}

export interface WeeklyDigestHistoryDetail {
	metadata: WeeklyDigestHistoryMetadata;
	result: PeriodDigestRunResult;
}

interface WeeklyDigestHistoryRow extends Record<string, unknown> {
	id: string;
	week_start: string;
	week_end: string;
	timezone: string;
	status: string;
	claim_token: string;
	attempt_count: number;
	format_version: number;
	window_since: string;
	window_until: string;
	include_dms: number;
	include_feed: number;
	twitter_scope: string;
	provider: string;
	model: string;
	reasoning_effort: string;
	service_tier: string;
	context_hash: string;
	counts_json: string;
	digest_json: string;
	markdown: string;
	tweets_json: string;
	dms_json: string;
	links_json: string;
	feed_json: string;
	error: string | null;
	started_at: string;
	finished_at: string | null;
	created_at: string;
	updated_at: string;
}

const EMPTY_COUNTS: PeriodDigestRunResult["context"]["counts"] = {
	home: 0,
	mentions: 0,
	authored: 0,
	likes: 0,
	bookmarks: 0,
	dms: 0,
	links: 0,
	feed: 0,
};
const CLAIM_STALE_MS = 30 * 60_000;

function parseJson<T>(value: string, fallback: T): T {
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function statusFromRow(value: string): WeeklyDigestHistoryStatus {
	return value === "ready" || value === "failed" ? value : "pending";
}

function localDateKey(date: Date) {
	const year = String(date.getFullYear()).padStart(4, "0");
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function parseLocalDateKey(value: string) {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) throw new Error("Weekly digest date must use YYYY-MM-DD");
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const date = new Date(year, month - 1, day);
	if (
		date.getFullYear() !== year ||
		date.getMonth() !== month - 1 ||
		date.getDate() !== day
	) {
		throw new Error("Weekly digest date is invalid");
	}
	return date;
}

export function localWeekStartKey(date = new Date()) {
	const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
	const daysSinceMonday = (start.getDay() + 6) % 7;
	start.setDate(start.getDate() - daysSinceMonday);
	return localDateKey(start);
}

export function previousCompletedWeekStartKey(date = new Date()) {
	const currentWeekStart = parseLocalDateKey(localWeekStartKey(date));
	currentWeekStart.setDate(currentWeekStart.getDate() - 7);
	return localDateKey(currentWeekStart);
}

export function localWindowForWeekStart(weekStart: string) {
	const since = parseLocalDateKey(weekStart);
	if (since.getDay() !== 1) {
		throw new Error("Weekly digest must start on a local Monday");
	}
	const until = new Date(
		since.getFullYear(),
		since.getMonth(),
		since.getDate() + 7,
	);
	const end = new Date(
		until.getFullYear(),
		until.getMonth(),
		until.getDate() - 1,
	);
	return {
		since: since.toISOString(),
		until: until.toISOString(),
		endDate: localDateKey(end),
	};
}

export function weeklyDigestPdfPath(weekStart: string) {
	return path.join(
		getBirdclawPaths().rootDir,
		"reports",
		"weekly",
		`BirdClaw-${weekStart}-weekly-digest.pdf`,
	);
}

function metadataFromRow(
	row: WeeklyDigestHistoryRow,
): WeeklyDigestHistoryMetadata {
	const digest = parseJson<PeriodDigestRunResult["digest"] | null>(
		row.digest_json,
		null,
	);
	return {
		id: row.id,
		kind: "weekly",
		date: row.week_start,
		endDate: row.week_end,
		timezone: row.timezone,
		status: statusFromRow(row.status),
		title:
			digest?.title ?? `Weekly digest · ${row.week_start} – ${row.week_end}`,
		summary:
			digest?.summary ??
			(row.status === "failed"
				? "Generation will retry automatically."
				: "Generation in progress…"),
		counts: {
			...EMPTY_COUNTS,
			...parseJson(row.counts_json, {}),
		},
		...(row.provider ? { provider: row.provider } : {}),
		...(row.model ? { model: row.model } : {}),
		attemptCount: Number(row.attempt_count),
		formatVersion: Number(row.format_version),
		...(row.error ? { error: row.error } : {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		...(row.finished_at ? { finishedAt: row.finished_at } : {}),
		pdfAvailable:
			row.status === "ready" && existsSync(weeklyDigestPdfPath(row.week_start)),
	};
}

function detailFromRow(
	row: WeeklyDigestHistoryRow,
): WeeklyDigestHistoryDetail | null {
	if (row.status !== "ready") return null;
	const digest = parseJson<PeriodDigestRunResult["digest"] | null>(
		row.digest_json,
		null,
	);
	if (!digest) return null;
	const metadata = metadataFromRow(row);
	return {
		metadata,
		result: {
			context: {
				window: {
					label: `${row.week_start} – ${row.week_end}`,
					since: row.window_since,
					until: row.window_until,
				},
				includeDms: Boolean(row.include_dms),
				includeFeed: Boolean(row.include_feed),
				twitterScope: row.twitter_scope === "home" ? "home" : "all",
				counts: metadata.counts,
				tweets: parseJson(row.tweets_json, []),
				dms: parseJson(row.dms_json, []),
				links: parseJson(row.links_json, []),
				feedItems: parseJson(row.feed_json, []),
				hash: row.context_hash,
			},
			digest,
			markdown: row.markdown,
			model: row.model,
			...(row.provider ? { provider: row.provider } : {}),
			reasoningEffort: row.reasoning_effort,
			serviceTier: row.service_tier,
			cached: true,
			updatedAt: row.finished_at ?? row.updated_at,
		},
	};
}

function rowById(id: string, db: Database) {
	return db
		.prepare("select * from weekly_digest_history where id = ?")
		.get(id) as WeeklyDigestHistoryRow | undefined;
}

export function listWeeklyDigestHistory(
	options: { limit?: number } = {},
	db = getReadDb(),
) {
	const limit = Math.max(1, Math.min(260, Math.trunc(options.limit ?? 52)));
	const rows = db
		.prepare(
			"select * from weekly_digest_history order by week_start desc limit ?",
		)
		.all(limit) as WeeklyDigestHistoryRow[];
	return rows.map(metadataFromRow);
}

export function getWeeklyDigestHistory(id: string, db = getReadDb()) {
	const row = rowById(id, db);
	return row ? detailFromRow(row) : null;
}

function compactContext(result: PeriodDigestRunResult) {
	const referencedIds = new Set([
		...result.digest.sourceTweetIds,
		...result.digest.keyTopics.flatMap((topic) => topic.tweetIds),
		...result.digest.notableLinks.flatMap((link) => link.sourceTweetIds),
		...result.digest.actionItems.flatMap((item) =>
			item.tweetId ? [item.tweetId] : [],
		),
	]);
	for (const citation of result.markdown.matchAll(/[（(]([^()（）]+)[）)]/g)) {
		for (const token of (citation[1] ?? "").split(/[\s,，、;；]+/)) {
			const id = token.trim().replace(/^tweet[_:]/i, "");
			if (id) referencedIds.add(id);
		}
	}
	const tweets = result.context.tweets.filter((tweet) =>
		[...referencedIds].some(
			(id) => id === tweet.id || id.replace(/^tweet[_:]/i, "") === tweet.id,
		),
	);
	return {
		tweets,
		dms: result.context.dms,
		links: result.context.links,
		feedItems: result.context.feedItems ?? [],
	};
}

export function claimWeeklyDigest(weekStart: string, db = getNativeDb()) {
	const { since, until, endDate } = localWindowForWeekStart(weekStart);
	const now = new Date().toISOString();
	const staleBefore = new Date(Date.now() - CLAIM_STALE_MS).toISOString();
	return db.transaction(() => {
		const claimToken = randomUUID();
		const existing = db
			.prepare("select * from weekly_digest_history where week_start = ?")
			.get(weekStart) as WeeklyDigestHistoryRow | undefined;
		const hasCurrentReadyReport =
			existing?.status === "ready" &&
			Number(existing.format_version) >= CURRENT_WEEKLY_DIGEST_FORMAT_VERSION;
		const hasActiveUpgrade =
			existing?.status === "ready" &&
			!hasCurrentReadyReport &&
			Boolean(existing.claim_token) &&
			existing.started_at > staleBefore;
		if (
			hasCurrentReadyReport ||
			hasActiveUpgrade ||
			(existing?.status === "pending" && existing.updated_at > staleBefore)
		) {
			return {
				claimed: false as const,
				id: existing.id,
				status: hasActiveUpgrade ? "pending" : existing.status,
			};
		}
		if (existing) {
			const timezone =
				Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
			const preserveReady = existing.status === "ready";
			db.prepare(
				`update weekly_digest_history
				 set status = ?, claim_token = ?, attempt_count = attempt_count + 1,
				     week_end = ?, timezone = ?, window_since = ?, window_until = ?,
				     error = null, started_at = ?,
				     finished_at = case when ? then finished_at else null end,
				     updated_at = case when ? then updated_at else ? end
				 where id = ?`,
			).run(
				preserveReady ? "ready" : "pending",
				claimToken,
				endDate,
				timezone,
				since,
				until,
				now,
				preserveReady ? 1 : 0,
				preserveReady ? 1 : 0,
				now,
				existing.id,
			);
			return {
				claimed: true as const,
				id: existing.id,
				claimToken,
				status: preserveReady ? ("ready" as const) : ("pending" as const),
				preserveReady,
			};
		}
		const id = randomUUID();
		db.prepare(
			`insert into weekly_digest_history (
			 id, week_start, week_end, timezone, status, claim_token, attempt_count,
			 window_since, window_until, started_at, created_at, updated_at
			) values (?, ?, ?, ?, 'pending', ?, 1, ?, ?, ?, ?, ?)`,
		).run(
			id,
			weekStart,
			endDate,
			Intl.DateTimeFormat().resolvedOptions().timeZone || "local",
			claimToken,
			since,
			until,
			now,
			now,
			now,
		);
		return {
			claimed: true as const,
			id,
			claimToken,
			status: "pending" as const,
			preserveReady: false,
		};
	})();
}

export function completeWeeklyDigestHistory(
	id: string,
	claimToken: string,
	result: PeriodDigestRunResult,
	db = getNativeDb(),
) {
	const compact = compactContext(result);
	const now = new Date().toISOString();
	const changed = db
		.prepare(
			`update weekly_digest_history set
			 status = 'ready', claim_token = '', format_version = ?,
				 include_dms = ?, include_feed = ?, twitter_scope = ?, provider = ?, model = ?,
			 reasoning_effort = ?, service_tier = ?, context_hash = ?,
			 counts_json = ?, digest_json = ?, markdown = ?, tweets_json = ?,
			 dms_json = ?, links_json = ?, feed_json = ?, error = null, finished_at = ?, updated_at = ?
			 where id = ? and claim_token = ?
			   and (
			     status = 'pending'
			     or (status = 'ready' and format_version < ?)
			   )`,
		)
		.run(
			CURRENT_WEEKLY_DIGEST_FORMAT_VERSION,
			result.context.includeDms ? 1 : 0,
			result.context.includeFeed ? 1 : 0,
			result.context.twitterScope === "home" ? "home" : "all",
			result.provider ?? "",
			result.model,
			result.reasoningEffort,
			result.serviceTier,
			result.context.hash,
			JSON.stringify(result.context.counts),
			JSON.stringify(result.digest),
			result.markdown,
			JSON.stringify(compact.tweets),
			JSON.stringify(compact.dms),
			JSON.stringify(compact.links),
			JSON.stringify(compact.feedItems),
			now,
			now,
			id,
			claimToken,
			CURRENT_WEEKLY_DIGEST_FORMAT_VERSION,
		).changes;
	return changed > 0;
}

export function failWeeklyDigestHistory(
	id: string,
	claimToken: string,
	error: unknown,
	options: { preserveReady?: boolean } = {},
	db = getNativeDb(),
) {
	const now = new Date().toISOString();
	const message = redactProviderError(
		error instanceof Error ? error.message : String(error),
	).slice(0, 2_000);
	const preserveReady = options.preserveReady === true;
	return (
		db
			.prepare(
				`update weekly_digest_history
				 set status = ?, claim_token = '', error = ?,
				     finished_at = case when ? then finished_at else ? end,
				     updated_at = case when ? then updated_at else ? end
				 where id = ? and claim_token = ? and status in ('pending', 'ready')`,
			)
			.run(
				preserveReady ? "ready" : "failed",
				message,
				preserveReady ? 1 : 0,
				now,
				preserveReady ? 1 : 0,
				now,
				id,
				claimToken,
			).changes > 0
	);
}

async function archiveWeeklyDigestWithStream(
	weekStart: string,
	{ signal }: { signal?: AbortSignal } = {},
	stream: typeof streamPeriodDigest = streamPeriodDigest,
) {
	const claim = claimWeeklyDigest(weekStart);
	if (!claim.claimed) {
		return { generated: false as const, id: claim.id, status: claim.status };
	}
	const window = localWindowForWeekStart(weekStart);
	try {
		const result = await stream({
			period: "week",
			since: window.since,
			until: window.until,
			includeDms: false,
			includeFeed: true,
			twitterScope: "home",
			refresh: false,
			reasoningEffort: "high",
			serviceTier: "priority",
			maxTweets: 5_000,
			maxLinks: 50,
			reportProfile: "weekly-deep-dive",
			maxOutputTokens: 16_000,
			liveSync: false,
			signal,
			bufferModelDeltasUntilSuccess: true,
		});
		const completed = completeWeeklyDigestHistory(
			claim.id,
			claim.claimToken,
			result,
		);
		if (!completed) {
			return { generated: false as const, id: claim.id, status: "superseded" };
		}
		return { generated: true as const, id: claim.id, status: "ready" as const };
	} catch (error) {
		const preserved = failWeeklyDigestHistory(
			claim.id,
			claim.claimToken,
			error,
			{
				preserveReady: claim.preserveReady,
			},
		);
		if (claim.preserveReady && preserved) {
			return {
				generated: false as const,
				id: claim.id,
				status: "ready" as const,
				upgradeFailed: true as const,
			};
		}
		throw error;
	}
}

export function archiveWeeklyDigest(
	weekStart: string,
	options: { signal?: AbortSignal } = {},
) {
	return archiveWeeklyDigestWithStream(weekStart, options);
}

export const __test__ = {
	archiveWeeklyDigestWithStream,
	compactContext,
	detailFromRow,
	metadataFromRow,
};
