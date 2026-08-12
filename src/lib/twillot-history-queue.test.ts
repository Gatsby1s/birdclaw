// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import { buildLocalCloudBridgeBatch } from "./local-cloud-bridge";
import type { Database } from "./sqlite";
import { insertTestProfile, insertTestTweet } from "../test/test-home";
import {
	claimTwillotHistoryJob,
	completeTwillotHistoryBatch,
	enqueueTwillotHistoryJob,
	failTwillotHistoryJob,
	getNextTwillotUsageDayStart,
	getTwillotHistoryJob,
	getTwillotHistoryQueueSummary,
	getTwillotHistoryQueueSnapshot,
	listTwillotHistoryJobs,
	markTwillotHistoryCaptureStatus,
	renewTwillotHistoryLease,
	retryFailedTwillotHistoryJob,
	TwillotHistoryQueueError,
	verifyTwillotHistoryJobComplete,
} from "./twillot-history-queue";
import type { XurlMentionsResponse } from "./types";

const tempDirs: string[] = [];

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createDatabase() {
	const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-twillot-"));
	tempDirs.push(tempDir);
	process.env.BIRDCLAW_HOME = tempDir;
	const db = getNativeDb({ seedDemoData: false });
	db.prepare(
		`insert into accounts (
       id, name, handle, external_user_id, transport, is_default, created_at
     ) values (?, ?, ?, ?, 'xurl', 1, ?)`,
	).run(
		"account-primary",
		"Primary",
		"primary",
		"100",
		"2026-08-10T00:00:00.000Z",
	);
	return db;
}

function enqueue(
	db: Database,
	profileId: string,
	handle: string,
	now = new Date("2026-08-10T01:00:00.000Z"),
) {
	return enqueueTwillotHistoryJob(db, {
		accountId: "account-primary",
		profileId,
		externalUserId: profileId.replace("profile_user_", ""),
		handle,
		now,
	});
}

function payload(
	userId: string,
	handle: string,
	tweetIds: string[],
): XurlMentionsResponse {
	return {
		data: tweetIds.map((id, index) => ({
			id,
			author_id: userId,
			text: `history ${id}`,
			created_at: `2025-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
			public_metrics: { like_count: index + 1 },
		})),
		includes: {
			users: [
				{
					id: userId,
					name: handle,
					username: handle,
					description: `${handle} archive`,
					public_metrics: { followers_count: 42, tweet_count: 100 },
				},
			],
		},
	};
}

describe("Twillot history queue", () => {
	it("migrates the durable tables and enqueues each account/profile/provider once", () => {
		const db = createDatabase();
		const now = new Date("2026-08-10T01:00:00.000Z");
		const first = enqueue(db, "profile_user_200", "@first", now);
		const second = enqueueTwillotHistoryJob(db, {
			accountId: "account-primary",
			profileId: "profile_user_200",
			externalUserId: "200",
			handle: "first-renamed",
			now: new Date("2026-08-10T01:01:00.000Z"),
		});

		expect(Number(db.pragma("user_version", { simple: true }))).toBe(16);
		expect(second.id).toBe(first.id);
		expect(second.handle).toBe("first-renamed");
		expect(second.state).toBe("queued");
		expect(second.captureStatus).toBe("capture_requested");
		expect(
			db.prepare("select count(*) as count from twillot_history_jobs").get(),
		).toEqual({ count: 1 });
	});

	it("fences capture status, imports canonical tweets, and charges a batch once", () => {
		const db = createDatabase();
		const now = new Date("2026-08-10T01:00:00.000Z");
		const job = enqueue(db, "profile_user_200", "first", now);
		const claim = claimTwillotHistoryJob(db, {
			now,
			dailyLimit: 20_000,
			requestedCap: 500,
		});
		expect(claim?.id).toBe(job.id);
		expect(claim?.allowance).toBe(500);

		const waiting = markTwillotHistoryCaptureStatus(db, {
			jobId: job.id,
			leaseToken: claim?.leaseToken ?? "",
			status: "waiting_for_twillot",
			now,
		});
		expect(waiting.captureStatus).toBe("waiting_for_twillot");

		const input = {
			jobId: job.id,
			leaseToken: claim?.leaseToken ?? "",
			batchId: "batch-one",
			downloadedCount: 2,
			payload: payload("200", "first", ["tweet-1", "tweet-2"]),
			cursor: { bottom: "cursor-2" },
			done: true,
			now,
		};
		const first = completeTwillotHistoryBatch(db, input);
		const replay = completeTwillotHistoryBatch(db, {
			...input,
			leaseToken: "00000000-0000-4000-8000-000000000000",
		});

		expect(first).toMatchObject({
			importedCount: 2,
			downloadedCount: 2,
			state: "completed",
			idempotentReplay: false,
		});
		expect(replay).toMatchObject({
			importedCount: 2,
			downloadedCount: 2,
			idempotentReplay: true,
		});
		expect(db.prepare("select count(*) as count from tweets").get()).toEqual({
			count: 2,
		});
		expect(
			db
				.prepare(
					"select kind, source from tweet_account_edges where tweet_id = ?",
				)
				.get("tweet-1"),
		).toEqual({ kind: "profile", source: "twillot" });
		expect(
			db
				.prepare("select text from tweets_fts where tweet_id = ?")
				.get("tweet-1"),
		).toEqual({ text: "history tweet-1" });
		const cloudBatch = buildLocalCloudBridgeBatch({
			cursor: {
				updatedAt: "",
				accountId: "",
				tweetId: "",
				kind: "",
				bookmarkSourceAccountId: "",
				localBookmarkUpdatedAt: "",
				localBookmarkAccountId: "",
				localBookmarkTweetId: "",
				nativeBookmarkUpdatedAt: "",
				nativeBookmarkAccountId: "",
				nativeBookmarkTweetId: "",
				cloudBookmarkUpdatedAt: "",
				cloudBookmarkAccountId: "",
				cloudBookmarkTweetId: "",
			},
			db,
		});
		expect(cloudBatch.edges).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					accountId: "account-primary",
					tweetId: "tweet-1",
					kind: "profile",
					source: "twillot",
				}),
			]),
		);
		expect(cloudBatch.tweets).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "tweet-1", text: "history tweet-1" }),
			]),
		);
		expect(
			db
				.prepare("select downloaded_count from twillot_history_daily_usage")
				.get(),
		).toEqual({ downloaded_count: 2 });

		const caughtUp = db
			.prepare(
				"select state, capture_status from twillot_history_jobs where id = ?",
			)
			.get(job.id);
		expect(caughtUp).toEqual({
			state: "completed",
			capture_status: "caught_up_unverified",
		});
		expect(
			verifyTwillotHistoryJobComplete(db, { jobId: job.id, now }).captureStatus,
		).toBe("verified_complete");
	});

	it("rejects a stale worker after reclaiming an expired lease", () => {
		const db = createDatabase();
		const startedAt = new Date("2026-08-10T01:00:00.000Z");
		const job = enqueue(db, "profile_user_200", "first", startedAt);
		const stale = claimTwillotHistoryJob(db, {
			now: startedAt,
			requestedCap: 10,
			leaseMs: 1_000,
		});
		const reclaimedAt = new Date("2026-08-10T01:00:02.000Z");
		const current = claimTwillotHistoryJob(db, {
			now: reclaimedAt,
			requestedCap: 10,
			leaseMs: 1_000,
		});

		expect(current?.id).toBe(job.id);
		expect(current?.leaseToken).not.toBe(stale?.leaseToken);
		let staleError: unknown;
		try {
			completeTwillotHistoryBatch(db, {
				jobId: job.id,
				leaseToken: stale?.leaseToken ?? "",
				batchId: "stale-batch",
				downloadedCount: 1,
				payload: payload("200", "first", ["stale-tweet"]),
				done: false,
				now: reclaimedAt,
			});
		} catch (error) {
			staleError = error;
		}
		expect(staleError).toBeInstanceOf(TwillotHistoryQueueError);
		expect(staleError).toMatchObject({ code: "STALE_LEASE" });
	});

	it("refreshes a renamed target from the canonical profile before claim", () => {
		const db = createDatabase();
		const now = new Date("2026-08-10T01:00:00.000Z");
		const job = enqueue(db, "profile_user_200", "old_handle", now);
		insertTestProfile(db, {
			id: "profile_user_200",
			handle: "new_handle",
			displayName: "Renamed Target",
		});

		const claim = claimTwillotHistoryJob(db, { now, requestedCap: 10 });

		expect(claim).toMatchObject({ id: job.id, handle: "new_handle" });
	});

	it("does not downgrade a richer canonical tweet or profile", () => {
		const db = createDatabase();
		insertTestProfile(db, {
			id: "profile_user_200",
			handle: "first",
			displayName: "Rich Display Name",
			bio: "rich profile biography",
			followersCount: 900,
			followingCount: 80,
			publicMetricsJson: '{"followers_count":900,"following_count":80}',
			entitiesJson: '{"url":{"urls":[{"expanded_url":"https://example.com"}]}}',
			rawJson: '{"id":"200","username":"first","verified":true}',
		});
		insertTestTweet(db, {
			id: "tweet-existing",
			authorProfileId: "profile_user_200",
			text: "A much longer canonical full text that must survive",
			createdAt: "2024-01-01T00:00:00.000Z",
			likeCount: 99,
			entitiesJson: '{"hashtags":[{"tag":"rich"}]}',
			mediaCount: 1,
			mediaJson: '[{"type":"photo","url":"https://example.com/image.jpg"}]',
		});
		const now = new Date("2026-08-10T01:00:00.000Z");
		const job = enqueue(db, "profile_user_200", "first", now);
		const claim = claimTwillotHistoryJob(db, { now, requestedCap: 10 });
		completeTwillotHistoryBatch(db, {
			jobId: job.id,
			leaseToken: claim?.leaseToken ?? "",
			batchId: "quality-preserving-batch",
			downloadedCount: 1,
			payload: payload("200", "first", ["tweet-existing"]),
			done: true,
			now,
		});

		expect(
			db
				.prepare(
					`select text, created_at, like_count, entities_json, media_count,
					        media_json from tweets where id = 'tweet-existing'`,
				)
				.get(),
		).toEqual({
			text: "A much longer canonical full text that must survive",
			created_at: "2024-01-01T00:00:00.000Z",
			like_count: 99,
			entities_json: '{"hashtags":[{"tag":"rich"}]}',
			media_count: 1,
			media_json: '[{"type":"photo","url":"https://example.com/image.jpg"}]',
		});
		expect(
			db
				.prepare(
					`select display_name, bio, followers_count, entities_json, raw_json
					 from profiles where id = 'profile_user_200'`,
				)
				.get(),
		).toEqual({
			display_name: "Rich Display Name",
			bio: "rich profile biography",
			followers_count: 900,
			entities_json:
				'{"url":{"urls":[{"expanded_url":"https://example.com"}]}}',
			raw_json: expect.stringContaining('"verified":true'),
		});
		expect(
			db
				.prepare("select text from tweets_fts where tweet_id = ?")
				.get("tweet-existing"),
		).toEqual({
			text: "A much longer canonical full text that must survive",
		});
	});

	it("shares the daily limit across accounts and resumes deferred work next Shanghai day", () => {
		const db = createDatabase();
		const dayOne = new Date("2026-08-10T15:00:00.000Z");
		const first = enqueue(db, "profile_user_200", "first", dayOne);
		const second = enqueue(
			db,
			"profile_user_300",
			"second",
			new Date("2026-08-10T15:00:01.000Z"),
		);

		const firstClaim = claimTwillotHistoryJob(db, {
			now: dayOne,
			dailyLimit: 3,
			requestedCap: 2,
		});
		expect(firstClaim?.id).toBe(first.id);
		completeTwillotHistoryBatch(db, {
			jobId: first.id,
			leaseToken: firstClaim?.leaseToken ?? "",
			batchId: "first-complete",
			downloadedCount: 2,
			payload: payload("200", "first", ["shared", "first-only"]),
			done: true,
			dailyLimit: 3,
			now: dayOne,
		});

		const secondClaim = claimTwillotHistoryJob(db, {
			now: new Date("2026-08-10T15:01:00.000Z"),
			dailyLimit: 3,
			requestedCap: 2,
		});
		expect(secondClaim?.id).toBe(second.id);
		expect(secondClaim?.allowance).toBe(1);
		const deferred = completeTwillotHistoryBatch(db, {
			jobId: second.id,
			leaseToken: secondClaim?.leaseToken ?? "",
			batchId: "second-partial",
			downloadedCount: 1,
			payload: payload("300", "second", ["shared"]),
			cursor: "continue-second",
			done: false,
			dailyLimit: 3,
			now: new Date("2026-08-10T15:01:00.000Z"),
		});
		expect(deferred).toMatchObject({
			state: "deferred",
			importedCount: 0,
			nextRunAt: "2026-08-10T16:00:00.000Z",
		});
		expect(
			claimTwillotHistoryJob(db, {
				now: new Date("2026-08-10T15:30:00.000Z"),
				dailyLimit: 3,
				requestedCap: 2,
			}),
		).toBeNull();

		const summary = getTwillotHistoryQueueSummary(db, {
			now: new Date("2026-08-10T15:30:00.000Z"),
			dailyLimit: 3,
		});
		expect(summary).toMatchObject({
			usageDay: "2026-08-10",
			downloadedToday: 3,
			remainingToday: 0,
			totalDownloaded: 3,
			totalImported: 2,
			states: { completed: 1, deferred: 1 },
		});

		const dayTwo = new Date("2026-08-10T16:00:00.000Z");
		const resumed = claimTwillotHistoryJob(db, {
			now: dayTwo,
			dailyLimit: 3,
			requestedCap: 2,
		});
		expect(resumed).toMatchObject({
			id: second.id,
			cursor: "continue-second",
			allowance: 2,
		});
		expect(
			getTwillotHistoryQueueSummary(db, { now: dayTwo, dailyLimit: 3 }),
		).toMatchObject({
			usageDay: "2026-08-11",
			downloadedToday: 0,
			reservedToday: 2,
			remainingToday: 1,
		});
	});

	it("renews, fails, retries, and snapshots a leased job without losing its cursor", () => {
		const db = createDatabase();
		const now = new Date("2026-08-10T01:00:00.000Z");
		const job = enqueue(db, "profile_user_200", "first", now);
		const claim = claimTwillotHistoryJob(db, {
			now,
			requestedCap: 7,
			leaseMs: 60_000,
		});
		const renewed = renewTwillotHistoryLease(db, {
			jobId: job.id,
			leaseToken: claim?.leaseToken ?? "",
			status: "ingesting",
			leaseMs: 120_000,
			now: new Date("2026-08-10T01:00:01.000Z"),
		});
		expect(renewed.captureStatus).toBe("ingesting");

		const failed = failTwillotHistoryJob(db, {
			jobId: job.id,
			leaseToken: claim?.leaseToken ?? "",
			error: " ",
			now: new Date("2026-08-10T01:00:02.000Z"),
		});
		expect(failed).toMatchObject({
			state: "failed",
			captureStatus: "needs_attention",
			lastError: "Unknown Twillot worker failure",
		});
		const retried = retryFailedTwillotHistoryJob(db, {
			jobId: job.id,
			now: new Date("2026-08-10T01:00:03.000Z"),
		});
		expect(retried).toMatchObject({
			state: "queued",
			captureStatus: "capture_requested",
		});
		expect(getTwillotHistoryJob(db, job.id)?.id).toBe(job.id);
		expect(listTwillotHistoryJobs(db, { limit: 999 })).toHaveLength(1);
		expect(getTwillotHistoryQueueSnapshot(db, { limit: 1 })).toMatchObject({
			jobs: [{ id: job.id }],
			states: { queued: 1 },
		});
	});

	it("keeps a partial batch queued and reserves the remaining daily allowance", () => {
		const db = createDatabase();
		const now = new Date("2026-08-10T01:00:00.000Z");
		const first = enqueue(db, "profile_user_200", "first", now);
		enqueue(db, "profile_user_300", "second", new Date(now.getTime() + 1));
		const claim = claimTwillotHistoryJob(db, {
			now,
			dailyLimit: 5,
			requestedCap: 5,
		});
		expect(
			claimTwillotHistoryJob(db, {
				now,
				dailyLimit: 5,
				requestedCap: 5,
			}),
		).toBeNull();
		const result = completeTwillotHistoryBatch(db, {
			jobId: first.id,
			leaseToken: claim?.leaseToken ?? "",
			batchId: "partial-under-limit",
			downloadedCount: 1,
			payload: payload("200", "first", ["partial-1"]),
			done: false,
			dailyLimit: 5,
			now,
		});
		expect(result).toMatchObject({ state: "queued", cursor: null });
	});

	it("rejects invalid queue requests and immutable batch receipt conflicts", () => {
		const db = createDatabase();
		const now = new Date("2026-08-10T01:00:00.000Z");
		expect(() => getNextTwillotUsageDayStart("2026/08/10")).toThrowError(
			TwillotHistoryQueueError,
		);
		expect(() => enqueue(db, "profile_user_200", " ", now)).toThrowError(
			TwillotHistoryQueueError,
		);
		expect(() =>
			claimTwillotHistoryJob(db, { now, dailyLimit: 0 }),
		).toThrowError(TwillotHistoryQueueError);
		expect(() =>
			claimTwillotHistoryJob(db, { now, requestedCap: -1 }),
		).toThrowError(TwillotHistoryQueueError);
		expect(() =>
			claimTwillotHistoryJob(db, { now, leaseMs: 1.5 }),
		).toThrowError(TwillotHistoryQueueError);

		const job = enqueue(db, "profile_user_200", "first", now);
		const claim = claimTwillotHistoryJob(db, { now, requestedCap: 1 });
		expect(() =>
			completeTwillotHistoryBatch(db, {
				jobId: job.id,
				leaseToken: claim?.leaseToken ?? "",
				batchId: "too-many",
				downloadedCount: 2,
				payload: payload("200", "first", ["1", "2"]),
				done: false,
				now,
			}),
		).toThrowError(expect.objectContaining({ code: "ALLOWANCE_EXCEEDED" }));
		expect(() =>
			completeTwillotHistoryBatch(db, {
				jobId: job.id,
				leaseToken: claim?.leaseToken ?? "",
				batchId: "negative",
				downloadedCount: -1,
				payload: payload("200", "first", []),
				done: false,
				now,
			}),
		).toThrowError(TwillotHistoryQueueError);
		expect(() =>
			completeTwillotHistoryBatch(db, {
				jobId: job.id,
				leaseToken: claim?.leaseToken ?? "",
				batchId: "short-count",
				downloadedCount: 0,
				payload: payload("200", "first", ["1"]),
				done: false,
				now,
			}),
		).toThrowError(TwillotHistoryQueueError);

		const accepted = completeTwillotHistoryBatch(db, {
			jobId: job.id,
			leaseToken: claim?.leaseToken ?? "",
			batchId: "immutable",
			downloadedCount: 1,
			payload: payload("200", "first", ["1"]),
			done: true,
			now,
		});
		expect(accepted.state).toBe("completed");
		expect(() =>
			completeTwillotHistoryBatch(db, {
				jobId: job.id,
				leaseToken: claim?.leaseToken ?? "",
				batchId: "immutable",
				downloadedCount: 1,
				payload: payload("200", "first", ["1"]),
				cursor: "different",
				done: true,
				now,
			}),
		).toThrowError(TwillotHistoryQueueError);
		expect(() =>
			retryFailedTwillotHistoryJob(db, { jobId: job.id, now }),
		).toThrow("Only a failed Twillot history job can be retried");
		expect(() =>
			verifyTwillotHistoryJobComplete(db, { jobId: job.id, now }),
		).not.toThrow();
		expect(() =>
			verifyTwillotHistoryJobComplete(db, { jobId: job.id, now }),
		).toThrow("Only a caught-up Twillot job can be marked verified complete");
		expect(() => getTwillotHistoryJob(db, " ")).toThrowError(
			TwillotHistoryQueueError,
		);
		expect(() => listTwillotHistoryJobs(db, { limit: 0 })).toThrowError(
			TwillotHistoryQueueError,
		);
		expect(() =>
			completeTwillotHistoryBatch(db, {
				jobId: "missing-job",
				leaseToken: "missing-lease",
				batchId: "missing-job-batch",
				downloadedCount: 0,
				payload: payload("200", "first", []),
				done: false,
				now,
			}),
		).toThrowError(expect.objectContaining({ code: "JOB_NOT_FOUND" }));
		expect(() =>
			completeTwillotHistoryBatch(db, {
				jobId: job.id,
				leaseToken: "missing-lease",
				batchId: "invalid-payload",
				downloadedCount: 0,
				payload: { data: null } as never,
				done: false,
				now,
			}),
		).toThrow("payload.data must be an array");
		expect(() =>
			markTwillotHistoryCaptureStatus(db, {
				jobId: job.id,
				leaseToken: "stale",
				status: "capturing",
				now,
			}),
		).toThrowError(expect.objectContaining({ code: "STALE_LEASE" }));
		expect(() =>
			renewTwillotHistoryLease(db, {
				jobId: job.id,
				leaseToken: "stale",
				now,
			}),
		).toThrowError(expect.objectContaining({ code: "STALE_LEASE" }));
		expect(() =>
			failTwillotHistoryJob(db, {
				jobId: job.id,
				leaseToken: "stale",
				error: "stale",
				now,
			}),
		).toThrowError(expect.objectContaining({ code: "STALE_LEASE" }));
	});

	it("uses safe defaults for optional provider, timestamps, cursor, and listing", () => {
		const db = createDatabase();
		const job = enqueueTwillotHistoryJob(db, {
			accountId: "account-primary",
			profileId: "profile_user_400",
			handle: "@defaults",
		});
		expect(job).toMatchObject({
			handle: "defaults",
			externalUserId: null,
			provider: "twillot",
		});
		expect(getTwillotHistoryJob(db, "missing-job")).toBeNull();
		const claim = claimTwillotHistoryJob(db);
		expect(claim?.id).toBe(job.id);
		const renewed = renewTwillotHistoryLease(db, {
			jobId: job.id,
			leaseToken: claim?.leaseToken ?? "",
		});
		expect(renewed.captureStatus).toBe("capturing");
		const result = completeTwillotHistoryBatch(db, {
			jobId: job.id,
			leaseToken: claim?.leaseToken ?? "",
			batchId: "default-options",
			downloadedCount: 0,
			payload: payload("400", "defaults", []),
			cursor: () => undefined,
			done: true,
		});
		expect(result).toMatchObject({ cursor: null, state: "completed" });
		expect(listTwillotHistoryJobs(db)).toHaveLength(1);
	});
});
