import { randomUUID } from "node:crypto";
import type { Database } from "./sqlite";
import { ingestTweetPayload, replaceTweetFts } from "./tweet-repository";
import type {
	XurlMentionData,
	XurlMentionsResponse,
	XurlMentionUser,
} from "./types";

export const TWILLOT_HISTORY_PROVIDER = "twillot";
export const TWILLOT_HISTORY_TIMEZONE = "Asia/Shanghai";
export const DEFAULT_TWILLOT_DAILY_LIMIT = 20_000;
export const DEFAULT_TWILLOT_LEASE_MS = 5 * 60 * 1000;

export type TwillotHistoryJobState =
	| "queued"
	| "leased"
	| "deferred"
	| "completed"
	| "failed";

export type TwillotHistoryCaptureStatus =
	| "capture_requested"
	| "waiting_for_twillot"
	| "capturing"
	| "ingesting"
	| "caught_up_unverified"
	| "verified_complete"
	| "needs_attention";

export type TwillotHistoryQueueErrorCode =
	| "INVALID_REQUEST"
	| "JOB_NOT_FOUND"
	| "STALE_LEASE"
	| "ALLOWANCE_EXCEEDED";

export class TwillotHistoryQueueError extends Error {
	constructor(
		readonly code: TwillotHistoryQueueErrorCode,
		message: string,
	) {
		super(message);
		this.name = "TwillotHistoryQueueError";
	}
}

interface TwillotHistoryJobRow {
	id: string;
	account_id: string;
	profile_id: string;
	provider: string;
	external_user_id: string | null;
	handle: string;
	state: TwillotHistoryJobState;
	capture_status: TwillotHistoryCaptureStatus;
	cursor_json: string;
	next_run_at: string;
	lease_token: string | null;
	lease_expires_at: string | null;
	lease_usage_day: string | null;
	lease_allowance: number;
	attempt_count: number;
	downloaded_count: number;
	imported_count: number;
	last_error: string | null;
	created_at: string;
	updated_at: string;
	completed_at: string | null;
}

interface TwillotHistoryBatchRow {
	provider: string;
	batch_id: string;
	job_id: string;
	lease_token: string;
	usage_day: string;
	downloaded_count: number;
	imported_count: number;
	cursor_json: string;
	done: number;
	resulting_state: "queued" | "deferred" | "completed";
	next_run_at: string | null;
	created_at: string;
}

export interface TwillotHistoryJob {
	id: string;
	accountId: string;
	profileId: string;
	provider: string;
	externalUserId: string | null;
	handle: string;
	state: TwillotHistoryJobState;
	captureStatus: TwillotHistoryCaptureStatus;
	cursor: unknown;
	nextRunAt: string;
	leaseToken: string | null;
	leaseExpiresAt: string | null;
	leaseUsageDay: string | null;
	leaseAllowance: number;
	attemptCount: number;
	downloadedCount: number;
	importedCount: number;
	lastError: string | null;
	createdAt: string;
	updatedAt: string;
	completedAt: string | null;
}

export interface TwillotHistoryClaim extends TwillotHistoryJob {
	state: "leased";
	leaseToken: string;
	leaseExpiresAt: string;
	leaseUsageDay: string;
	allowance: number;
}

export interface EnqueueTwillotHistoryJobInput {
	accountId: string;
	profileId: string;
	externalUserId?: string | null;
	handle: string;
	provider?: string;
	now?: Date;
}

export interface ClaimTwillotHistoryJobOptions {
	provider?: string;
	dailyLimit?: number;
	requestedCap?: number;
	leaseMs?: number;
	now?: Date;
}

export interface CompleteTwillotHistoryBatchInput {
	jobId: string;
	leaseToken: string;
	batchId: string;
	downloadedCount: number;
	payload: XurlMentionsResponse;
	cursor?: unknown;
	done: boolean;
	provider?: string;
	dailyLimit?: number;
	now?: Date;
}

export interface TwillotHistoryBatchResult {
	jobId: string;
	batchId: string;
	usageDay: string;
	downloadedCount: number;
	importedCount: number;
	cursor: unknown;
	done: boolean;
	state: "queued" | "deferred" | "completed";
	nextRunAt: string | null;
	idempotentReplay: boolean;
}

export interface TwillotHistoryQueueSummary {
	provider: string;
	timezone: typeof TWILLOT_HISTORY_TIMEZONE;
	usageDay: string;
	dailyLimit: number;
	downloadedToday: number;
	reservedToday: number;
	remainingToday: number;
	nextResetAt: string;
	activeLeases: number;
	nextEligibleAt: string | null;
	totalDownloaded: number;
	totalImported: number;
	states: Record<TwillotHistoryJobState, number>;
	captureStatuses: Record<TwillotHistoryCaptureStatus, number>;
}

export interface TwillotHistoryQueueSnapshot extends TwillotHistoryQueueSummary {
	jobs: TwillotHistoryJob[];
}

const shanghaiDayFormatter = new Intl.DateTimeFormat("en-CA", {
	timeZone: TWILLOT_HISTORY_TIMEZONE,
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
});

function positiveInteger(value: number, label: string) {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new TwillotHistoryQueueError(
			"INVALID_REQUEST",
			`${label} must be a positive integer`,
		);
	}
	return value;
}

function nonNegativeInteger(value: number, label: string) {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new TwillotHistoryQueueError(
			"INVALID_REQUEST",
			`${label} must be a non-negative integer`,
		);
	}
	return value;
}

function requiredString(value: string, label: string) {
	const normalized = value.trim();
	if (!normalized) {
		throw new TwillotHistoryQueueError(
			"INVALID_REQUEST",
			`${label} is required`,
		);
	}
	return normalized;
}

function parseJson(value: string) {
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return null;
	}
}

function serializeCursor(cursor: unknown) {
	const serialized = JSON.stringify(cursor ?? null);
	return serialized === undefined ? "null" : serialized;
}

function parseRecordJson(value: string | null | undefined) {
	try {
		const parsed = JSON.parse(value || "{}");
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function meaningfulJson(value: unknown) {
	const serialized = JSON.stringify(value ?? {});
	return serialized !== "{}" && serialized !== "[]" && serialized !== "null"
		? serialized
		: "";
}

function preserveCanonicalTweet(
	db: Database,
	tweet: XurlMentionData,
): XurlMentionData {
	const existing = db
		.prepare(
			`select text, created_at, like_count, entities_json
			 from tweets where id = ?`,
		)
		.get(tweet.id) as
		| {
				text: string;
				created_at: string;
				like_count: number;
				entities_json: string;
		  }
		| undefined;
	if (!existing) return tweet;
	const incomingEntities = meaningfulJson(tweet.entities);
	const storedEntities = meaningfulJson(
		parseRecordJson(existing.entities_json),
	);
	return {
		...tweet,
		text:
			existing.text.trim().length >= tweet.text.trim().length
				? existing.text
				: tweet.text,
		created_at: existing.created_at || tweet.created_at,
		entities:
			storedEntities.length >= incomingEntities.length
				? parseRecordJson(existing.entities_json)
				: tweet.entities,
		public_metrics: {
			...tweet.public_metrics,
			like_count: Math.max(
				Number(existing.like_count ?? 0),
				Number(tweet.public_metrics?.like_count ?? 0),
			),
		},
	};
}

function preserveCanonicalProfile(
	db: Database,
	user: XurlMentionUser,
): XurlMentionUser {
	const row = db
		.prepare(
			`select handle, display_name, bio, followers_count, following_count,
			        public_metrics_json, avatar_url, location, url, verified_type,
			        entities_json, raw_json
			 from profiles
			 where id = ? or lower(handle) = lower(?)
			 order by case when id = ? then 0 else 1 end, created_at desc, id
			 limit 1`,
		)
		.get(
			`profile_user_${user.id}`,
			user.username,
			`profile_user_${user.id}`,
		) as
		| {
				handle: string;
				display_name: string;
				bio: string;
				followers_count: number;
				following_count: number;
				public_metrics_json: string;
				avatar_url: string | null;
				location: string | null;
				url: string | null;
				verified_type: string | null;
				entities_json: string;
				raw_json: string;
		  }
		| undefined;
	if (!row) return user;
	const raw = parseRecordJson(row.raw_json);
	const storedMetrics = parseRecordJson(row.public_metrics_json);
	const storedEntities = parseRecordJson(row.entities_json);
	return {
		...raw,
		...user,
		id: String(user.id),
		username: row.handle,
		name: row.display_name,
		description: row.bio || user.description,
		public_metrics: {
			...user.public_metrics,
			...storedMetrics,
			followers_count: Math.max(
				row.followers_count,
				Number(user.public_metrics?.followers_count ?? 0),
			),
			following_count: Math.max(
				row.following_count,
				Number(user.public_metrics?.following_count ?? 0),
			),
		},
		profile_image_url: row.avatar_url ?? user.profile_image_url,
		location: row.location ?? user.location,
		url: row.url ?? user.url,
		verified_type: row.verified_type ?? user.verified_type,
		entities:
			Object.keys(storedEntities).length > 0 ? storedEntities : user.entities,
	};
}

function qualityPreservingTwillotPayload(
	db: Database,
	payload: XurlMentionsResponse,
): XurlMentionsResponse {
	return {
		...payload,
		data: payload.data.map((tweet) => preserveCanonicalTweet(db, tweet)),
		includes: {
			...payload.includes,
			tweets: payload.includes?.tweets?.map((tweet) =>
				preserveCanonicalTweet(db, tweet),
			),
			users: payload.includes?.users?.map((user) =>
				preserveCanonicalProfile(db, user),
			),
		},
	};
}

export function getTwillotUsageDay(now: Date = new Date()) {
	const parts = Object.fromEntries(
		shanghaiDayFormatter
			.formatToParts(now)
			.filter((part) => part.type !== "literal")
			.map((part) => [part.type, part.value]),
	);
	return `${parts.year}-${parts.month}-${parts.day}`;
}

export function getNextTwillotUsageDayStart(usageDay: string) {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(usageDay);
	if (!match) {
		throw new TwillotHistoryQueueError(
			"INVALID_REQUEST",
			"usageDay must use YYYY-MM-DD",
		);
	}
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	return new Date(Date.UTC(year, month - 1, day + 1) - 8 * 60 * 60 * 1000);
}

function jobFromRow(row: TwillotHistoryJobRow): TwillotHistoryJob {
	return {
		id: row.id,
		accountId: row.account_id,
		profileId: row.profile_id,
		provider: row.provider,
		externalUserId: row.external_user_id,
		handle: row.handle,
		state: row.state,
		captureStatus: row.capture_status,
		cursor: parseJson(row.cursor_json),
		nextRunAt: row.next_run_at,
		leaseToken: row.lease_token,
		leaseExpiresAt: row.lease_expires_at,
		leaseUsageDay: row.lease_usage_day,
		leaseAllowance: Number(row.lease_allowance),
		attemptCount: Number(row.attempt_count),
		downloadedCount: Number(row.downloaded_count),
		importedCount: Number(row.imported_count),
		lastError: row.last_error,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		completedAt: row.completed_at,
	};
}

function getJobRow(db: Database, jobId: string) {
	return db
		.prepare("select * from twillot_history_jobs where id = ?")
		.get(jobId) as TwillotHistoryJobRow | undefined;
}

export function getTwillotHistoryJob(db: Database, jobId: string) {
	const row = getJobRow(db, requiredString(jobId, "jobId"));
	return row ? jobFromRow(row) : null;
}

function batchResultFromRow(
	row: TwillotHistoryBatchRow,
	idempotentReplay: boolean,
): TwillotHistoryBatchResult {
	return {
		jobId: row.job_id,
		batchId: row.batch_id,
		usageDay: row.usage_day,
		downloadedCount: Number(row.downloaded_count),
		importedCount: Number(row.imported_count),
		cursor: parseJson(row.cursor_json),
		done: Boolean(row.done),
		state: row.resulting_state,
		nextRunAt: row.next_run_at,
		idempotentReplay,
	};
}

function reclaimExpiredLeases(db: Database, provider: string, nowIso: string) {
	db.prepare(
		`
    update twillot_history_jobs
    set state = case when next_run_at > ? then 'deferred' else 'queued' end,
        capture_status = 'capture_requested',
        lease_token = null,
        lease_expires_at = null,
        lease_usage_day = null,
        lease_allowance = 0,
        updated_at = ?
    where provider = ?
      and state = 'leased'
      and lease_expires_at <= ?
    `,
	).run(nowIso, nowIso, provider, nowIso);
}

function getDownloadedUsage(db: Database, provider: string, usageDay: string) {
	const row = db
		.prepare(
			`select downloaded_count
       from twillot_history_daily_usage
       where provider = ? and usage_day = ?`,
		)
		.get(provider, usageDay) as { downloaded_count: number } | undefined;
	return Number(row?.downloaded_count ?? 0);
}

function getActiveReservation(
	db: Database,
	provider: string,
	usageDay: string,
	nowIso: string,
	excludeJobId?: string,
) {
	const row = db
		.prepare(
			`
      select coalesce(sum(lease_allowance), 0) as reserved
      from twillot_history_jobs
      where provider = ?
        and state = 'leased'
        and lease_usage_day = ?
        and lease_expires_at > ?
        and (? is null or id <> ?)
      `,
		)
		.get(
			provider,
			usageDay,
			nowIso,
			excludeJobId ?? null,
			excludeJobId ?? null,
		) as { reserved: number };
	return Number(row.reserved ?? 0);
}

export function enqueueTwillotHistoryJob(
	db: Database,
	input: EnqueueTwillotHistoryJobInput,
) {
	const accountId = requiredString(input.accountId, "accountId");
	const profileId = requiredString(input.profileId, "profileId");
	const handle = requiredString(input.handle, "handle").replace(/^@/, "");
	const provider = requiredString(
		input.provider ?? TWILLOT_HISTORY_PROVIDER,
		"provider",
	);
	const nowIso = (input.now ?? new Date()).toISOString();
	const id = randomUUID();

	db.prepare(
		`
    insert into twillot_history_jobs (
      id, account_id, profile_id, provider, external_user_id, handle, state,
      capture_status, next_run_at, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, 'queued', 'capture_requested', ?, ?, ?)
    on conflict(account_id, profile_id, provider) do update set
      external_user_id = coalesce(excluded.external_user_id, external_user_id),
      handle = excluded.handle,
      updated_at = excluded.updated_at
    `,
	).run(
		id,
		accountId,
		profileId,
		provider,
		input.externalUserId?.trim() || null,
		handle,
		nowIso,
		nowIso,
		nowIso,
	);

	const row = db
		.prepare(
			`select * from twillot_history_jobs
       where account_id = ? and profile_id = ? and provider = ?`,
		)
		.get(accountId, profileId, provider) as TwillotHistoryJobRow;
	return jobFromRow(row);
}

export function claimTwillotHistoryJob(
	db: Database,
	options: ClaimTwillotHistoryJobOptions = {},
): TwillotHistoryClaim | null {
	const provider = requiredString(
		options.provider ?? TWILLOT_HISTORY_PROVIDER,
		"provider",
	);
	const dailyLimit = positiveInteger(
		options.dailyLimit ?? DEFAULT_TWILLOT_DAILY_LIMIT,
		"dailyLimit",
	);
	const requestedCap = positiveInteger(
		options.requestedCap ?? dailyLimit,
		"requestedCap",
	);
	const leaseMs = positiveInteger(
		options.leaseMs ?? DEFAULT_TWILLOT_LEASE_MS,
		"leaseMs",
	);
	const now = options.now ?? new Date();
	const nowIso = now.toISOString();
	const usageDay = getTwillotUsageDay(now);
	const nextReset = getNextTwillotUsageDayStart(usageDay);

	return db.transaction((): TwillotHistoryClaim | null => {
		reclaimExpiredLeases(db, provider, nowIso);
		const downloaded = getDownloadedUsage(db, provider, usageDay);
		const reserved = getActiveReservation(db, provider, usageDay, nowIso);
		const remaining = Math.max(0, dailyLimit - downloaded - reserved);

		if (downloaded >= dailyLimit) {
			db.prepare(
				`
        update twillot_history_jobs
        set state = 'deferred', next_run_at = ?, updated_at = ?
        where provider = ?
          and state in ('queued', 'deferred')
          and next_run_at <= ?
        `,
			).run(nextReset.toISOString(), nowIso, provider, nowIso);
			return null;
		}
		if (remaining === 0) return null;

		let row = db
			.prepare(
				`
        select *
        from twillot_history_jobs
        where provider = ?
          and state in ('queued', 'deferred')
          and next_run_at <= ?
        order by next_run_at, created_at, id
        limit 1
        `,
			)
			.get(provider, nowIso) as TwillotHistoryJobRow | undefined;
		if (!row) return null;
		const canonicalProfile = db
			.prepare("select handle from profiles where id = ?")
			.get(row.profile_id) as { handle: string } | undefined;
		const canonicalHandle = canonicalProfile?.handle?.replace(/^@/, "").trim();
		if (canonicalHandle && canonicalHandle !== row.handle) {
			db.prepare(
				"update twillot_history_jobs set handle = ?, updated_at = ? where id = ?",
			).run(canonicalHandle, nowIso, row.id);
			row = { ...row, handle: canonicalHandle, updated_at: nowIso };
		}

		const allowance = Math.min(remaining, requestedCap);
		const leaseToken = randomUUID();
		const leaseExpiresAt = new Date(
			Math.min(now.getTime() + leaseMs, nextReset.getTime()),
		).toISOString();
		const claimed = db
			.prepare(
				`
        update twillot_history_jobs
        set state = 'leased',
            capture_status = 'capturing',
            lease_token = ?,
            lease_expires_at = ?,
            lease_usage_day = ?,
            lease_allowance = ?,
            attempt_count = attempt_count + 1,
            last_error = null,
            updated_at = ?
        where id = ? and state in ('queued', 'deferred')
        `,
			)
			.run(leaseToken, leaseExpiresAt, usageDay, allowance, nowIso, row.id);
		if (claimed.changes !== 1) return null;

		const job = jobFromRow(getJobRow(db, row.id) as TwillotHistoryJobRow);
		return {
			...job,
			state: "leased",
			leaseToken,
			leaseExpiresAt,
			leaseUsageDay: usageDay,
			allowance,
		};
	})();
}

export function completeTwillotHistoryBatch(
	db: Database,
	input: CompleteTwillotHistoryBatchInput,
): TwillotHistoryBatchResult {
	const provider = requiredString(
		input.provider ?? TWILLOT_HISTORY_PROVIDER,
		"provider",
	);
	const jobId = requiredString(input.jobId, "jobId");
	const leaseToken = requiredString(input.leaseToken, "leaseToken");
	const batchId = requiredString(input.batchId, "batchId");
	const downloadedCount = nonNegativeInteger(
		input.downloadedCount,
		"downloadedCount",
	);
	const dailyLimit = positiveInteger(
		input.dailyLimit ?? DEFAULT_TWILLOT_DAILY_LIMIT,
		"dailyLimit",
	);
	if (!Array.isArray(input.payload?.data)) {
		throw new TwillotHistoryQueueError(
			"INVALID_REQUEST",
			"payload.data must be an array",
		);
	}
	if (downloadedCount < input.payload.data.length) {
		throw new TwillotHistoryQueueError(
			"INVALID_REQUEST",
			"downloadedCount cannot be smaller than payload.data.length",
		);
	}
	const now = input.now ?? new Date();
	const nowIso = now.toISOString();
	const usageDay = getTwillotUsageDay(now);
	const cursorJson = serializeCursor(input.cursor);

	return db.transaction((): TwillotHistoryBatchResult => {
		const existing = db
			.prepare(
				`select * from twillot_history_batches
         where provider = ? and batch_id = ?`,
			)
			.get(provider, batchId) as TwillotHistoryBatchRow | undefined;
		if (existing) {
			if (
				existing.job_id !== jobId ||
				Number(existing.downloaded_count) !== downloadedCount ||
				existing.cursor_json !== cursorJson ||
				Boolean(existing.done) !== input.done
			) {
				throw new TwillotHistoryQueueError(
					"INVALID_REQUEST",
					"batchId already belongs to a different Twillot batch",
				);
			}
			return batchResultFromRow(existing, true);
		}

		const row = getJobRow(db, jobId);
		if (!row || row.provider !== provider) {
			throw new TwillotHistoryQueueError(
				"JOB_NOT_FOUND",
				"Twillot history job was not found",
			);
		}
		if (
			row.state !== "leased" ||
			row.lease_token !== leaseToken ||
			!row.lease_expires_at ||
			row.lease_expires_at <= nowIso ||
			row.lease_usage_day !== usageDay
		) {
			throw new TwillotHistoryQueueError(
				"STALE_LEASE",
				"Twillot history lease is stale or no longer owns the job",
			);
		}
		if (downloadedCount > Number(row.lease_allowance)) {
			throw new TwillotHistoryQueueError(
				"ALLOWANCE_EXCEEDED",
				"downloadedCount exceeds the lease allowance",
			);
		}

		const uniqueTweets = [
			...new Map(input.payload.data.map((tweet) => [tweet.id, tweet])).values(),
		];
		const uniqueTweetIds = new Set(uniqueTweets.map((tweet) => tweet.id));
		let importedCount = 0;
		const existingCanonicalTweets = new Map<
			string,
			{
				text: string;
				created_at: string;
				like_count: number;
				media_count: number;
				entities_json: string;
				media_json: string;
			}
		>();
		for (const tweetId of uniqueTweetIds) {
			const existing = db
				.prepare(
					`select text, created_at, like_count, media_count, entities_json,
					        media_json from tweets where id = ?`,
				)
				.get(tweetId) as
				| {
						text: string;
						created_at: string;
						like_count: number;
						media_count: number;
						entities_json: string;
						media_json: string;
				  }
				| undefined;
			if (!existing) importedCount += 1;
			else existingCanonicalTweets.set(tweetId, existing);
		}
		ingestTweetPayload(db, {
			accountId: row.account_id,
			payload: qualityPreservingTwillotPayload(db, {
				...input.payload,
				data: uniqueTweets,
			}),
			source: TWILLOT_HISTORY_PROVIDER,
			edgeKind: "profile",
		});
		const preserveTweet = db.prepare(
			`update tweets
			 set text = case when length(?) >= length(text) then ? else text end,
			     created_at = ?,
			     like_count = max(like_count, ?),
			     media_count = max(media_count, ?),
			     entities_json = case
			       when ? not in ('', '{}', '[]', 'null') then ?
			       else entities_json
			     end,
			     media_json = case
			       when ? not in ('', '{}', '[]', 'null') then ?
			       else media_json
			     end
			 where id = ?`,
		);
		for (const [tweetId, existing] of existingCanonicalTweets) {
			preserveTweet.run(
				existing.text,
				existing.text,
				existing.created_at,
				existing.like_count,
				existing.media_count,
				existing.entities_json,
				existing.entities_json,
				existing.media_json,
				existing.media_json,
				tweetId,
			);
			const final = db
				.prepare("select text from tweets where id = ?")
				.get(tweetId) as { text: string };
			replaceTweetFts(db, tweetId, final.text);
		}

		db.prepare(
			`
      insert into twillot_history_daily_usage (
        provider, usage_day, downloaded_count, updated_at
      ) values (?, ?, ?, ?)
      on conflict(provider, usage_day) do update set
        downloaded_count = downloaded_count + excluded.downloaded_count,
        updated_at = excluded.updated_at
      `,
		).run(provider, usageDay, downloadedCount, nowIso);

		const downloadedToday = getDownloadedUsage(db, provider, usageDay);
		const state: TwillotHistoryBatchResult["state"] = input.done
			? "completed"
			: downloadedToday >= dailyLimit
				? "deferred"
				: "queued";
		const nextRunAt =
			state === "completed"
				? null
				: state === "deferred"
					? getNextTwillotUsageDayStart(usageDay).toISOString()
					: nowIso;

		db.prepare(
			`
      update twillot_history_jobs
      set state = ?,
          capture_status = ?,
          cursor_json = ?,
          next_run_at = coalesce(?, next_run_at),
          lease_token = null,
          lease_expires_at = null,
          lease_usage_day = null,
          lease_allowance = 0,
          downloaded_count = downloaded_count + ?,
          imported_count = imported_count + ?,
          last_error = null,
          updated_at = ?,
          completed_at = case when ? = 'completed' then ? else null end
      where id = ? and state = 'leased' and lease_token = ?
      `,
		).run(
			state,
			input.done ? "caught_up_unverified" : "capturing",
			cursorJson,
			nextRunAt,
			downloadedCount,
			importedCount,
			nowIso,
			state,
			nowIso,
			jobId,
			leaseToken,
		);

		db.prepare(
			`
      insert into twillot_history_batches (
        provider, batch_id, job_id, lease_token, usage_day, downloaded_count,
        imported_count, cursor_json, done, resulting_state, next_run_at, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
		).run(
			provider,
			batchId,
			jobId,
			leaseToken,
			usageDay,
			downloadedCount,
			importedCount,
			cursorJson,
			input.done ? 1 : 0,
			state,
			nextRunAt,
			nowIso,
		);

		return {
			jobId,
			batchId,
			usageDay,
			downloadedCount,
			importedCount,
			cursor: parseJson(cursorJson),
			done: input.done,
			state,
			nextRunAt,
			idempotentReplay: false,
		};
	})();
}

export function failTwillotHistoryJob(
	db: Database,
	input: {
		jobId: string;
		leaseToken: string;
		error: string;
		provider?: string;
		now?: Date;
	},
) {
	const provider = requiredString(
		input.provider ?? TWILLOT_HISTORY_PROVIDER,
		"provider",
	);
	const jobId = requiredString(input.jobId, "jobId");
	const leaseToken = requiredString(input.leaseToken, "leaseToken");
	const nowIso = (input.now ?? new Date()).toISOString();
	const result = db
		.prepare(
			`
      update twillot_history_jobs
      set state = 'failed',
          capture_status = 'needs_attention',
          lease_token = null,
          lease_expires_at = null,
          lease_usage_day = null,
          lease_allowance = 0,
          last_error = ?,
          updated_at = ?
      where id = ?
        and provider = ?
        and state = 'leased'
        and lease_token = ?
        and lease_expires_at > ?
      `,
		)
		.run(
			input.error.trim() || "Unknown Twillot worker failure",
			nowIso,
			jobId,
			provider,
			leaseToken,
			nowIso,
		);
	if (result.changes !== 1) {
		throw new TwillotHistoryQueueError(
			"STALE_LEASE",
			"Twillot history lease is stale or no longer owns the job",
		);
	}
	return jobFromRow(getJobRow(db, jobId) as TwillotHistoryJobRow);
}

export function retryFailedTwillotHistoryJob(
	db: Database,
	input: { jobId: string; provider?: string; now?: Date },
) {
	const provider = requiredString(
		input.provider ?? TWILLOT_HISTORY_PROVIDER,
		"provider",
	);
	const jobId = requiredString(input.jobId, "jobId");
	const nowIso = (input.now ?? new Date()).toISOString();
	const result = db
		.prepare(
			`
      update twillot_history_jobs
      set state = 'queued', capture_status = 'capture_requested',
          next_run_at = ?, last_error = null, updated_at = ?
      where id = ? and provider = ? and state = 'failed'
      `,
		)
		.run(nowIso, nowIso, jobId, provider);
	if (result.changes !== 1) {
		throw new TwillotHistoryQueueError(
			"INVALID_REQUEST",
			"Only a failed Twillot history job can be retried",
		);
	}
	return jobFromRow(getJobRow(db, jobId) as TwillotHistoryJobRow);
}

export function markTwillotHistoryCaptureStatus(
	db: Database,
	input: {
		jobId: string;
		leaseToken: string;
		status: "waiting_for_twillot" | "capturing" | "ingesting";
		provider?: string;
		now?: Date;
	},
) {
	const provider = requiredString(
		input.provider ?? TWILLOT_HISTORY_PROVIDER,
		"provider",
	);
	const jobId = requiredString(input.jobId, "jobId");
	const leaseToken = requiredString(input.leaseToken, "leaseToken");
	const nowIso = (input.now ?? new Date()).toISOString();
	const result = db
		.prepare(
			`
      update twillot_history_jobs
      set capture_status = ?, updated_at = ?
      where id = ?
        and provider = ?
        and state = 'leased'
        and lease_token = ?
        and lease_expires_at > ?
      `,
		)
		.run(input.status, nowIso, jobId, provider, leaseToken, nowIso);
	if (result.changes !== 1) {
		throw new TwillotHistoryQueueError(
			"STALE_LEASE",
			"Twillot history lease is stale or no longer owns the job",
		);
	}
	return jobFromRow(getJobRow(db, jobId) as TwillotHistoryJobRow);
}

export function renewTwillotHistoryLease(
	db: Database,
	input: {
		jobId: string;
		leaseToken: string;
		status?: "waiting_for_twillot" | "capturing" | "ingesting";
		provider?: string;
		leaseMs?: number;
		now?: Date;
	},
) {
	const provider = requiredString(
		input.provider ?? TWILLOT_HISTORY_PROVIDER,
		"provider",
	);
	const jobId = requiredString(input.jobId, "jobId");
	const leaseToken = requiredString(input.leaseToken, "leaseToken");
	const leaseMs = positiveInteger(
		input.leaseMs ?? DEFAULT_TWILLOT_LEASE_MS,
		"leaseMs",
	);
	const now = input.now ?? new Date();
	const nowIso = now.toISOString();
	const usageDay = getTwillotUsageDay(now);
	const leaseExpiresAt = new Date(
		Math.min(
			now.getTime() + leaseMs,
			getNextTwillotUsageDayStart(usageDay).getTime(),
		),
	).toISOString();
	const result = db
		.prepare(
			`
      update twillot_history_jobs
      set capture_status = coalesce(?, capture_status),
          lease_expires_at = ?,
          updated_at = ?
      where id = ?
        and provider = ?
        and state = 'leased'
        and lease_token = ?
        and lease_usage_day = ?
        and lease_expires_at > ?
      `,
		)
		.run(
			input.status ?? null,
			leaseExpiresAt,
			nowIso,
			jobId,
			provider,
			leaseToken,
			usageDay,
			nowIso,
		);
	if (result.changes !== 1) {
		throw new TwillotHistoryQueueError(
			"STALE_LEASE",
			"Twillot history lease is stale or no longer owns the job",
		);
	}
	return jobFromRow(getJobRow(db, jobId) as TwillotHistoryJobRow);
}

export function verifyTwillotHistoryJobComplete(
	db: Database,
	input: { jobId: string; provider?: string; now?: Date },
) {
	const provider = requiredString(
		input.provider ?? TWILLOT_HISTORY_PROVIDER,
		"provider",
	);
	const jobId = requiredString(input.jobId, "jobId");
	const nowIso = (input.now ?? new Date()).toISOString();
	const result = db
		.prepare(
			`
      update twillot_history_jobs
      set capture_status = 'verified_complete', updated_at = ?
      where id = ?
        and provider = ?
        and state = 'completed'
        and capture_status = 'caught_up_unverified'
      `,
		)
		.run(nowIso, jobId, provider);
	if (result.changes !== 1) {
		throw new TwillotHistoryQueueError(
			"INVALID_REQUEST",
			"Only a caught-up Twillot job can be marked verified complete",
		);
	}
	return jobFromRow(getJobRow(db, jobId) as TwillotHistoryJobRow);
}

export function getTwillotHistoryQueueSummary(
	db: Database,
	options: {
		provider?: string;
		dailyLimit?: number;
		now?: Date;
	} = {},
): TwillotHistoryQueueSummary {
	const provider = requiredString(
		options.provider ?? TWILLOT_HISTORY_PROVIDER,
		"provider",
	);
	const dailyLimit = positiveInteger(
		options.dailyLimit ?? DEFAULT_TWILLOT_DAILY_LIMIT,
		"dailyLimit",
	);
	const now = options.now ?? new Date();
	const nowIso = now.toISOString();
	const usageDay = getTwillotUsageDay(now);
	const downloadedToday = getDownloadedUsage(db, provider, usageDay);
	const reservedToday = getActiveReservation(db, provider, usageDay, nowIso);
	const stateRows = db
		.prepare(
			`select state, count(*) as count
       from twillot_history_jobs where provider = ? group by state`,
		)
		.all(provider) as Array<{ state: TwillotHistoryJobState; count: number }>;
	const states: Record<TwillotHistoryJobState, number> = {
		queued: 0,
		leased: 0,
		deferred: 0,
		completed: 0,
		failed: 0,
	};
	for (const row of stateRows) states[row.state] = Number(row.count);
	const captureStatusRows = db
		.prepare(
			`select capture_status, count(*) as count
       from twillot_history_jobs where provider = ? group by capture_status`,
		)
		.all(provider) as Array<{
		capture_status: TwillotHistoryCaptureStatus;
		count: number;
	}>;
	const captureStatuses: Record<TwillotHistoryCaptureStatus, number> = {
		capture_requested: 0,
		waiting_for_twillot: 0,
		capturing: 0,
		ingesting: 0,
		caught_up_unverified: 0,
		verified_complete: 0,
		needs_attention: 0,
	};
	for (const row of captureStatusRows) {
		captureStatuses[row.capture_status] = Number(row.count);
	}
	const totals = db
		.prepare(
			`select coalesce(sum(downloaded_count), 0) as downloaded,
              coalesce(sum(imported_count), 0) as imported
       from twillot_history_jobs where provider = ?`,
		)
		.get(provider) as { downloaded: number; imported: number };
	const next = db
		.prepare(
			`select min(next_run_at) as next_run_at
       from twillot_history_jobs
       where provider = ? and state in ('queued', 'deferred')`,
		)
		.get(provider) as { next_run_at: string | null };
	const active = db
		.prepare(
			`select count(*) as count from twillot_history_jobs
       where provider = ? and state = 'leased' and lease_expires_at > ?`,
		)
		.get(provider, nowIso) as { count: number };

	return {
		provider,
		timezone: TWILLOT_HISTORY_TIMEZONE,
		usageDay,
		dailyLimit,
		downloadedToday,
		reservedToday,
		remainingToday: Math.max(0, dailyLimit - downloadedToday - reservedToday),
		nextResetAt: getNextTwillotUsageDayStart(usageDay).toISOString(),
		activeLeases: Number(active.count),
		nextEligibleAt: next.next_run_at,
		totalDownloaded: Number(totals.downloaded),
		totalImported: Number(totals.imported),
		states,
		captureStatuses,
	};
}

export function listTwillotHistoryJobs(
	db: Database,
	options: { provider?: string; limit?: number } = {},
) {
	const provider = requiredString(
		options.provider ?? TWILLOT_HISTORY_PROVIDER,
		"provider",
	);
	const limit = Math.min(500, positiveInteger(options.limit ?? 100, "limit"));
	const rows = db
		.prepare(
			`
      select *
      from twillot_history_jobs
      where provider = ?
      order by
        case state
          when 'leased' then 0
          when 'queued' then 1
          when 'deferred' then 2
          when 'failed' then 3
          else 4
        end,
        next_run_at,
        created_at,
        id
      limit ?
      `,
		)
		.all(provider, limit) as TwillotHistoryJobRow[];
	return rows.map(jobFromRow);
}

export function getTwillotHistoryQueueSnapshot(
	db: Database,
	options: {
		provider?: string;
		dailyLimit?: number;
		now?: Date;
		limit?: number;
	} = {},
): TwillotHistoryQueueSnapshot {
	return {
		...getTwillotHistoryQueueSummary(db, options),
		jobs: listTwillotHistoryJobs(db, options),
	};
}
