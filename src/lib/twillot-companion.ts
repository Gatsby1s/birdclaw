import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Database } from "./sqlite";
import {
	claimTwillotHistoryJob,
	completeTwillotHistoryBatch,
	failTwillotHistoryJob,
	getTwillotHistoryJob,
	markTwillotHistoryCaptureStatus,
	renewTwillotHistoryLease,
} from "./twillot-history-queue";
import type { XurlMedia, XurlMentionData, XurlMentionsResponse } from "./types";

const CONNECTED_WINDOW_MS = 10 * 60_000;
export const TWILLOT_COMPANION_MAX_BATCH_RECORDS = 500;

const twillotMediaVariantSchema = z.strictObject({
	url: z.string().max(4_096),
	content_type: z.string().max(256),
	bitrate: z.number().int().nonnegative().optional(),
	bit_rate: z.number().int().nonnegative().optional(),
});

const twillotMediaItemSchema = z.strictObject({
	media_key: z.union([z.string(), z.number()]).optional(),
	id: z.union([z.string(), z.number()]).optional(),
	id_str: z.union([z.string(), z.number()]).optional(),
	type: z.string().max(64).optional(),
	url: z.string().max(4_096).optional(),
	preview_image_url: z.string().max(4_096).optional(),
	media_url: z.string().max(4_096).optional(),
	media_url_https: z.string().max(4_096).optional(),
	width: z.number().int().nonnegative().optional(),
	height: z.number().int().nonnegative().optional(),
	video_info: z
		.strictObject({
			variants: z.array(twillotMediaVariantSchema).max(64).optional(),
			duration_millis: z.number().int().nonnegative().optional(),
			aspect_ratio: z
				.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
				.optional(),
		})
		.optional(),
});

export const twillotPostRecordSchema = z
	.strictObject({
		id: z.union([z.string(), z.number()]),
		tweet_id: z.union([z.string(), z.number()]).optional(),
		conversation_id: z.union([z.string(), z.number()]).optional(),
		owner_id: z.union([z.string(), z.number()]).optional(),
		user_id: z.union([z.string(), z.number()]),
		category_name: z.literal("public-post"),
		sort_index: z.union([z.string(), z.number()]).optional(),
		created_at: z.union([z.string(), z.number()]),
		full_text: z.string().max(100_000),
		screen_name: z.string().trim().min(1).max(128),
		username: z.string().max(512).optional(),
		avatar_url: z.string().max(4_096).optional(),
		lang: z.string().max(64).optional(),
		views_count: z.number().int().nonnegative().optional(),
		bookmark_count: z.number().int().nonnegative().optional(),
		favorite_count: z.number().int().nonnegative().optional(),
		quote_count: z.number().int().nonnegative().optional(),
		reply_count: z.number().int().nonnegative().optional(),
		retweet_count: z.number().int().nonnegative().optional(),
		is_reply: z.boolean().optional(),
		is_quote: z.boolean().optional(),
		reply_to_id: z.union([z.string(), z.number()]).optional(),
		quoted_tweet_id: z.union([z.string(), z.number()]).optional(),
		entities: z.record(z.string(), z.unknown()).optional(),
		media_items: z.array(twillotMediaItemSchema).max(64).optional(),
	})
	.refine(
		(record) => /^\d+$/.test(String(record.tweet_id ?? record.id).trim()),
		{
			message: "Twillot post is missing a valid numeric tweet id",
		},
	);

export type TwillotPostRecord = z.infer<typeof twillotPostRecordSchema>;

const submissionBaseSchema = z.object({
	sourceId: z
		.string()
		.trim()
		.regex(/^[A-Za-z0-9_-]{8,128}$/),
	jobId: z.string().uuid(),
	leaseToken: z.string().uuid(),
});

export const twillotCompanionSubmissionSchema = z.discriminatedUnion("action", [
	submissionBaseSchema.extend({
		action: z.literal("heartbeat"),
		status: z
			.enum(["waiting_for_twillot", "capturing", "ingesting"])
			.optional(),
	}),
	submissionBaseSchema.extend({
		action: z.literal("batch"),
		batchId: z.string().trim().min(8).max(256),
		records: z
			.array(twillotPostRecordSchema)
			.max(TWILLOT_COMPANION_MAX_BATCH_RECORDS),
		cursor: z.unknown().optional(),
		done: z.boolean(),
		lastSyncTime: z
			.union([z.string().trim().min(1).max(256), z.number().nonnegative()])
			.optional(),
	}),
	submissionBaseSchema.extend({
		action: z.literal("error"),
		error: z.string().trim().min(1).max(10_000),
	}),
]);

export type TwillotCompanionSubmission = z.infer<
	typeof twillotCompanionSubmissionSchema
>;

interface CompanionRow {
	token_hash: string;
	token_created_at: string;
	source_id: string | null;
	last_seen_at: string | null;
	last_job_id: string | null;
	last_error: string | null;
}

function companionRow(db: Database) {
	return db
		.prepare(
			`select token_hash, token_created_at, source_id, last_seen_at,
			        last_job_id, last_error
			 from twillot_companion_sync where id = 1`,
		)
		.get() as CompanionRow | undefined;
}

function hashToken(token: string) {
	return createHash("sha256").update(token, "utf8").digest();
}

export interface TwillotCompanionStatus {
	paired: boolean;
	connected: boolean;
	tokenCreatedAt: string | null;
	sourceId: string | null;
	lastSeenAt: string | null;
	lastJobId: string | null;
	lastError: string | null;
}

export function getTwillotCompanionStatus(
	db: Database,
	now: Date = new Date(),
): TwillotCompanionStatus {
	const row = companionRow(db);
	const lastSeenMs = row?.last_seen_at
		? Date.parse(row.last_seen_at)
		: Number.NaN;
	return {
		paired: Boolean(row?.token_hash),
		connected:
			Boolean(row?.token_hash) &&
			Number.isFinite(lastSeenMs) &&
			now.getTime() - lastSeenMs <= CONNECTED_WINDOW_MS,
		tokenCreatedAt: row?.token_created_at ?? null,
		sourceId: row?.source_id ?? null,
		lastSeenAt: row?.last_seen_at ?? null,
		lastJobId: row?.last_job_id ?? null,
		lastError: row?.last_error ?? null,
	};
}

export function createTwillotCompanionPairing(
	db: Database,
	now: Date = new Date(),
) {
	const token = randomBytes(32).toString("base64url");
	const tokenHash = hashToken(token).toString("hex");
	const createdAt = now.toISOString();
	db.prepare(
		`
    insert into twillot_companion_sync (
      id, token_hash, token_created_at, source_id, last_seen_at,
      last_job_id, last_error
    ) values (1, ?, ?, null, null, null, null)
    on conflict(id) do update set
      token_hash = excluded.token_hash,
      token_created_at = excluded.token_created_at,
      source_id = null,
      last_seen_at = null,
      last_job_id = null,
      last_error = null
    `,
	).run(tokenHash, createdAt);
	return { ...getTwillotCompanionStatus(db, now), token };
}

export function disconnectTwillotCompanion(db: Database) {
	db.prepare("delete from twillot_companion_sync where id = 1").run();
	return getTwillotCompanionStatus(db);
}

export function isValidTwillotCompanionToken(token: string, db: Database) {
	const expectedHex = companionRow(db)?.token_hash;
	if (!expectedHex || !/^[a-f0-9]{64}$/.test(expectedHex)) return false;
	const expected = Buffer.from(expectedHex, "hex");
	const actual = hashToken(token);
	return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export class TwillotCompanionError extends Error {
	constructor(
		readonly code: "SOURCE_CONFLICT" | "TARGET_MISMATCH",
		message: string,
	) {
		super(message);
		this.name = "TwillotCompanionError";
	}
}

function recordCompanionSeen(
	db: Database,
	input: {
		sourceId: string;
		jobId?: string;
		error?: string | null;
		now?: Date;
	},
) {
	const row = companionRow(db);
	if (!row) throw new Error("Twillot companion is not paired");
	if (row.source_id && row.source_id !== input.sourceId) {
		throw new TwillotCompanionError(
			"SOURCE_CONFLICT",
			"This pairing already belongs to another Twillot companion.",
		);
	}
	const nowIso = (input.now ?? new Date()).toISOString();
	db.prepare(
		`
    update twillot_companion_sync
    set source_id = ?, last_seen_at = ?, last_job_id = coalesce(?, last_job_id),
        last_error = ?
    where id = 1
    `,
	).run(input.sourceId, nowIso, input.jobId ?? null, input.error ?? null);
}

export function claimTwillotCompanionJob(
	db: Database,
	input: {
		sourceId: string;
		requestedCap?: number;
		now?: Date;
	},
) {
	recordCompanionSeen(db, { sourceId: input.sourceId, now: input.now });
	const job = claimTwillotHistoryJob(db, {
		requestedCap: Math.min(
			TWILLOT_COMPANION_MAX_BATCH_RECORDS,
			input.requestedCap ?? TWILLOT_COMPANION_MAX_BATCH_RECORDS,
		),
		now: input.now,
	});
	if (job) {
		recordCompanionSeen(db, {
			sourceId: input.sourceId,
			jobId: job.id,
			now: input.now,
		});
	}
	return job;
}

function asRecord(value: unknown) {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function stringValue(value: unknown) {
	if (typeof value === "string" || typeof value === "number") {
		const normalized = String(value).trim();
		return normalized || undefined;
	}
	return undefined;
}

function countValue(value: unknown) {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function isoTimestamp(value: string | number) {
	if (typeof value === "number") {
		const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
		const date = new Date(milliseconds);
		return Number.isFinite(date.getTime())
			? date.toISOString()
			: new Date(0).toISOString();
	}
	const parsed = new Date(value);
	return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : value;
}

function mediaFromPost(post: TwillotPostRecord) {
	const candidates = post.media_items ?? [];
	const seen = new Set<string>();
	const media: XurlMedia[] = [];
	for (const [index, candidate] of candidates.entries()) {
		const item = asRecord(candidate);
		if (!item) continue;
		const videoInfo = asRecord(item.video_info);
		const url = stringValue(
			item.media_url_https ??
				item.media_url ??
				item.url ??
				item.preview_image_url,
		);
		const preview = stringValue(
			item.preview_image_url ?? item.media_url_https ?? item.media_url,
		);
		if (!url && !preview) continue;
		const key =
			stringValue(item.media_key ?? item.id_str ?? item.id) ??
			`${String(post.tweet_id ?? post.id)}:${String(index)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const variants = Array.isArray(videoInfo?.variants)
			? videoInfo.variants
					.map(asRecord)
					.filter((variant): variant is Record<string, unknown> =>
						Boolean(variant),
					)
					.map((variant) => ({
						url: stringValue(variant.url) ?? "",
						content_type:
							stringValue(variant.content_type ?? variant.contentType) ?? "",
						...(countValue(variant.bitrate ?? variant.bit_rate) > 0
							? { bit_rate: countValue(variant.bitrate ?? variant.bit_rate) }
							: {}),
					}))
					.filter((variant) => variant.url && variant.content_type)
			: [];
		media.push({
			media_key: key,
			type: stringValue(item.type) ?? "photo",
			...(url ? { url } : {}),
			...(preview ? { preview_image_url: preview } : {}),
			...(countValue(item.width) > 0 ? { width: countValue(item.width) } : {}),
			...(countValue(item.height) > 0
				? { height: countValue(item.height) }
				: {}),
			...(variants.length > 0 ? { variants } : {}),
		});
	}
	return media;
}

function postToTweet(post: TwillotPostRecord, media: XurlMedia[]) {
	const tweetId = String(post.tweet_id ?? post.id);
	const replyTo = stringValue(post.reply_to_id);
	const quoted = stringValue(post.quoted_tweet_id);
	const references = [
		...(replyTo ? [{ type: "replied_to", id: replyTo }] : []),
		...(quoted ? [{ type: "quoted", id: quoted }] : []),
	];
	const entities = post.entities as XurlMentionData["entities"];
	return {
		id: tweetId,
		author_id: String(post.user_id),
		text: post.full_text,
		created_at: isoTimestamp(post.created_at),
		conversation_id: stringValue(post.conversation_id) ?? tweetId,
		...(entities ? { entities } : {}),
		...(references.length > 0 ? { referenced_tweets: references } : {}),
		...(media.length > 0
			? { attachments: { media_keys: media.map((item) => item.media_key) } }
			: {}),
		public_metrics: {
			like_count: countValue(post.favorite_count),
			retweet_count: countValue(post.retweet_count),
			reply_count: countValue(post.reply_count),
			quote_count: countValue(post.quote_count),
			bookmark_count: countValue(post.bookmark_count),
			impression_count: countValue(post.views_count),
		},
	} satisfies XurlMentionData;
}

export function twillotRecordsToTweetPayload(
	records: TwillotPostRecord[],
): XurlMentionsResponse {
	const first = records[0];
	if (!first) return { data: [], includes: { users: [], media: [] } };
	const mediaByTweet = records.map((record) => mediaFromPost(record));
	const media = mediaByTweet.flat();
	return {
		data: records.map((record, index) =>
			postToTweet(record, mediaByTweet[index] ?? []),
		),
		includes: {
			users: [
				{
					id: String(first.user_id),
					name: first.username?.trim() || first.screen_name,
					username: first.screen_name,
					...(first.avatar_url ? { profile_image_url: first.avatar_url } : {}),
				},
			],
			media,
		},
	};
}

function assertRecordsMatchJob(
	records: TwillotPostRecord[],
	job: NonNullable<ReturnType<typeof getTwillotHistoryJob>>,
) {
	const expectedHandle = job.handle.replace(/^@/, "").toLowerCase();
	for (const record of records) {
		const externalMatches =
			!job.externalUserId || String(record.user_id) === job.externalUserId;
		const handleMatches = record.screen_name.toLowerCase() === expectedHandle;
		if (!externalMatches || !handleMatches) {
			throw new TwillotCompanionError(
				"TARGET_MISMATCH",
				"Twillot records do not belong to the leased BirdClaw profile.",
			);
		}
	}
}

export function applyTwillotCompanionSubmission(
	db: Database,
	input: TwillotCompanionSubmission,
	now: Date = new Date(),
) {
	const submission = twillotCompanionSubmissionSchema.parse(input);
	recordCompanionSeen(db, {
		sourceId: submission.sourceId,
		jobId: submission.jobId,
		now,
	});
	if (submission.action === "heartbeat") {
		return {
			ok: true as const,
			job: renewTwillotHistoryLease(db, {
				jobId: submission.jobId,
				leaseToken: submission.leaseToken,
				status: submission.status,
				now,
			}),
		};
	}
	if (submission.action === "error") {
		const job = failTwillotHistoryJob(db, {
			jobId: submission.jobId,
			leaseToken: submission.leaseToken,
			error: submission.error,
			now,
		});
		recordCompanionSeen(db, {
			sourceId: submission.sourceId,
			jobId: submission.jobId,
			error: submission.error,
			now,
		});
		return { ok: true as const, job };
	}

	const job = getTwillotHistoryJob(db, submission.jobId);
	if (!job) throw new Error("Twillot history job was not found");
	assertRecordsMatchJob(submission.records, job);
	if (job.state === "leased") {
		markTwillotHistoryCaptureStatus(db, {
			jobId: submission.jobId,
			leaseToken: submission.leaseToken,
			status: "ingesting",
			now,
		});
	}
	const payload = twillotRecordsToTweetPayload(submission.records);
	const result = completeTwillotHistoryBatch(db, {
		jobId: submission.jobId,
		leaseToken: submission.leaseToken,
		batchId: submission.batchId,
		downloadedCount: submission.records.length,
		payload,
		cursor: submission.cursor,
		done: submission.done && submission.lastSyncTime !== undefined,
		now,
	});
	return {
		ok: true as const,
		result,
		completeness: result.done ? "caught_up_unverified" : "incomplete",
	};
}

export const __test__ = {
	mediaFromPost,
};
