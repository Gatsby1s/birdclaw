// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import {
	applyTwillotCompanionSubmission,
	claimTwillotCompanionJob,
	createTwillotCompanionPairing,
	disconnectTwillotCompanion,
	getTwillotCompanionStatus,
	isValidTwillotCompanionToken,
	TwillotCompanionError,
	twillotRecordsToTweetPayload,
} from "./twillot-companion";
import { enqueueTwillotHistoryJob } from "./twillot-history-queue";

const tempDirs: string[] = [];

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function setup() {
	const root = mkdtempSync(path.join(os.tmpdir(), "birdclaw-twillot-live-"));
	tempDirs.push(root);
	process.env.BIRDCLAW_HOME = root;
	const db = getNativeDb({ seedDemoData: false });
	db.prepare(
		`insert into accounts (
		   id, name, handle, external_user_id, transport, is_default, created_at
		 ) values ('acct', 'Account', 'owner', '1', 'xurl', 1, ?)`,
	).run("2026-08-10T00:00:00.000Z");
	const job = enqueueTwillotHistoryJob(db, {
		accountId: "acct",
		profileId: "profile_user_42",
		externalUserId: "42",
		handle: "target",
		now: new Date("2026-08-10T01:00:00.000Z"),
	});
	return { db, job };
}

function record(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		tweet_id: id,
		conversation_id: id,
		owner_id: "1",
		user_id: "42",
		category_name: "public-post" as const,
		sort_index: id,
		created_at: "2025-03-01T12:00:00.000Z",
		full_text: `tweet ${id}`,
		screen_name: "target",
		username: "Target Person",
		favorite_count: 7,
		media_items: [
			{
				id_str: `media-${id}`,
				type: "photo",
				media_url_https: "https://pbs.twimg.com/media/example.jpg",
			},
		],
		...overrides,
	};
}

describe("Twillot companion", () => {
	it("pairs with a one-purpose token and reports recent heartbeats", () => {
		const { db } = setup();
		const paired = createTwillotCompanionPairing(
			db,
			new Date("2026-08-10T01:00:00.000Z"),
		);
		expect(paired.paired).toBe(true);
		expect(isValidTwillotCompanionToken(paired.token, db)).toBe(true);
		expect(isValidTwillotCompanionToken(`${paired.token}x`, db)).toBe(false);
		expect(
			getTwillotCompanionStatus(db, new Date("2026-08-10T01:00:01.000Z"))
				.connected,
		).toBe(false);

		const claim = claimTwillotCompanionJob(db, {
			sourceId: "source_12345678",
			now: new Date("2026-08-10T01:00:01.000Z"),
		});
		expect(claim?.handle).toBe("target");
		expect(
			getTwillotCompanionStatus(db, new Date("2026-08-10T01:00:02.000Z")),
		).toMatchObject({ connected: true, sourceId: "source_12345678" });
	});

	it("maps Twillot media and only marks a lastSyncTime batch caught up", () => {
		const { db, job } = setup();
		createTwillotCompanionPairing(db);
		const now = new Date("2026-08-10T01:00:01.000Z");
		const claim = claimTwillotCompanionJob(db, {
			sourceId: "source_12345678",
			now,
		});
		const mapped = twillotRecordsToTweetPayload([record("100")]);
		expect(mapped.data[0]).toMatchObject({
			id: "100",
			author_id: "42",
			attachments: { media_keys: ["media-100"] },
		});
		expect(mapped.includes?.media?.[0]).toMatchObject({
			media_key: "media-100",
			type: "photo",
		});

		const result = applyTwillotCompanionSubmission(
			db,
			{
				action: "batch",
				sourceId: "source_12345678",
				jobId: job.id,
				leaseToken: claim?.leaseToken ?? "",
				batchId: "batch-00000001",
				records: [record("100")],
				cursor: { tweetId: "100" },
				done: true,
			},
			now,
		);
		expect(result).toMatchObject({
			ok: true,
			completeness: "incomplete",
			result: { done: false, state: "queued" },
		});
		expect(db.prepare("select count(*) as count from tweets").get()).toEqual({
			count: 1,
		});
	});

	it("rejects records from a different public profile", () => {
		const { db, job } = setup();
		createTwillotCompanionPairing(db);
		const now = new Date("2026-08-10T01:00:01.000Z");
		const claim = claimTwillotCompanionJob(db, {
			sourceId: "source_12345678",
			now,
		});
		expect(() =>
			applyTwillotCompanionSubmission(
				db,
				{
					action: "batch",
					sourceId: "source_12345678",
					jobId: job.id,
					leaseToken: claim?.leaseToken ?? "",
					batchId: "batch-00000002",
					records: [record("200", { screen_name: "attacker" })],
					done: false,
				},
				now,
			),
		).toThrowError(TwillotCompanionError);
	});

	it("disconnects pairing and rejects a second companion source", () => {
		const { db } = setup();
		const pairing = createTwillotCompanionPairing(db);
		expect(isValidTwillotCompanionToken("", db)).toBe(false);
		claimTwillotCompanionJob(db, {
			sourceId: "source_12345678",
			requestedCap: 999,
			now: new Date("2026-08-10T01:00:01.000Z"),
		});
		expect(() =>
			claimTwillotCompanionJob(db, {
				sourceId: "source_87654321",
				now: new Date("2026-08-10T01:00:02.000Z"),
			}),
		).toThrowError(expect.objectContaining({ code: "SOURCE_CONFLICT" }));
		expect(disconnectTwillotCompanion(db)).toMatchObject({ paired: false });
		expect(isValidTwillotCompanionToken(pairing.token, db)).toBe(false);
	});

	it("fails closed before pairing and for a malformed stored token digest", () => {
		const { db } = setup();
		expect(() =>
			claimTwillotCompanionJob(db, { sourceId: "source_12345678" }),
		).toThrow("Twillot companion is not paired");
		createTwillotCompanionPairing(db);
		db.prepare(
			"update twillot_history_jobs set next_run_at = '2000-01-01T00:00:00.000Z'",
		).run();
		expect(
			claimTwillotCompanionJob(db, { sourceId: "source_12345678" }),
		).not.toBeNull();
		db.prepare(
			"update twillot_companion_sync set token_hash = 'bad' where id = 1",
		).run();
		expect(isValidTwillotCompanionToken("t".repeat(43), db)).toBe(false);
	});

	it("maps rich media, references, timestamps, metrics, and empty exports", () => {
		expect(twillotRecordsToTweetPayload([])).toEqual({
			data: [],
			includes: { users: [], media: [] },
		});
		const rich = record("300", {
			conversation_id: "250",
			reply_to_id: "249",
			quoted_tweet_id: undefined,
			created_at: 1_700_000_000,
			favorite_count: "9",
			retweet_count: -1,
			reply_count: "bad",
			quote_count: 3,
			bookmark_count: 4,
			views_count: 5,
			avatar_url: "https://pbs.twimg.com/avatar.jpg",
			entities: { hashtags: [{ tag: "archive" }] },
			media_items: [
				null,
				{ id: "missing-url" },
				{
					id: "video-1",
					type: "video",
					preview_image_url: "https://pbs.twimg.com/preview.jpg",
					width: "640",
					height: 360,
					video_info: {
						variants: [
							null,
							{
								url: "https://video.twimg.com/a.mp4",
								contentType: "video/mp4",
								bitrate: 832000,
							},
							{ url: "", content_type: "video/mp4" },
						],
					},
				},
				{
					id: "video-1",
					media_url: "https://pbs.twimg.com/duplicate.jpg",
				},
				{
					id: "photo-1",
					type: "photo",
					media_url_https: "https://pbs.twimg.com/photo.jpg",
					width: 1200,
					height: 800,
				},
			],
			quoted_tweet: {
				tweet_id: "248",
				user_id: "84",
				created_at: 1_699_000_000,
				full_text: "Quoted context",
				screen_name: "quoted_author",
				username: "Quoted Author",
			},
		});
		const mapped = twillotRecordsToTweetPayload([rich]);
		expect(mapped.data[0]).toMatchObject({
			id: "300",
			conversation_id: "250",
			created_at: "2023-11-14T22:13:20.000Z",
			referenced_tweets: [
				{ type: "replied_to", id: "249" },
				{ type: "quoted", id: "248" },
			],
			public_metrics: {
				like_count: 9,
				retweet_count: 0,
				reply_count: 0,
			},
		});
		expect(mapped.includes?.media).toEqual([
			expect.objectContaining({
				media_key: "photo-1",
				type: "photo",
				width: 1200,
				height: 800,
			}),
		]);
		expect(mapped.includes?.tweets).toEqual([
			expect.objectContaining({
				id: "248",
				author_id: "84",
				text: "Quoted context",
			}),
		]);
		expect(mapped.includes?.users).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "84", username: "quoted_author" }),
			]),
		);
		const fallback = twillotRecordsToTweetPayload([
			record("301", {
				created_at: 9_000_000_000_000_000,
				username: " ",
				avatar_url: "",
				media_items: [
					{
						type: "photo",
						preview_image_url: "https://pbs.twimg.com/fallback.jpg",
						width: 0,
						height: "bad",
						video_info: { variants: "bad" },
					},
				],
			}),
		]);
		expect(fallback.data[0]?.created_at).toBe("1970-01-01T00:00:00.000Z");
		expect(fallback.includes?.users?.[0]).toMatchObject({ name: "target" });
		expect(fallback.includes?.media?.[0]?.media_key).toBe("301:0");
		const stringFallback = twillotRecordsToTweetPayload([
			record("302", {
				tweet_id: undefined,
				created_at: "not-a-date",
				media_items: [
					{
						media_url: "https://pbs.twimg.com/default-type.jpg",
						video_info: {
							variants: [
								{
									url: "https://video.twimg.com/no-bitrate.mp4",
									content_type: "video/mp4",
									bit_rate: 0,
								},
								{
									url: "https://video.twimg.com/direct-bit-rate.mp4",
									content_type: "video/mp4",
									bit_rate: 256000,
								},
							],
						},
					},
				],
			}),
		]);
		expect(stringFallback.data[0]?.created_at).toBe("not-a-date");
		expect(stringFallback.includes?.media).toEqual([]);
		const minimal = twillotRecordsToTweetPayload([
			record("303", {
				conversation_id: undefined,
				media_items: [
					{
						id_str: "url-only",
						url: "https://pbs.twimg.com/url-only.jpg",
						video_info: {
							variants: [{ url: "https://video.twimg.com/ignored.mp4" }],
						},
					},
				],
			}),
			record("304", { media_items: undefined }),
		]);
		expect(minimal.data[0]?.conversation_id).toBe("303");
		expect(minimal.includes?.media).toEqual([]);
	});

	it("handles heartbeat and permanent worker error submissions", () => {
		const { db, job } = setup();
		createTwillotCompanionPairing(db);
		const now = new Date("2026-08-10T01:00:01.000Z");
		const claim = claimTwillotCompanionJob(db, {
			sourceId: "source_12345678",
			now,
		});
		const heartbeat = applyTwillotCompanionSubmission(
			db,
			{
				action: "heartbeat",
				sourceId: "source_12345678",
				jobId: job.id,
				leaseToken: claim?.leaseToken ?? "",
				status: "waiting_for_twillot",
			},
			new Date("2026-08-10T01:00:02.000Z"),
		);
		expect(heartbeat).toMatchObject({
			job: { captureStatus: "waiting_for_twillot" },
		});
		const failed = applyTwillotCompanionSubmission(
			db,
			{
				action: "error",
				sourceId: "source_12345678",
				jobId: job.id,
				leaseToken: claim?.leaseToken ?? "",
				error: "Twillot schema changed",
			},
			new Date("2026-08-10T01:00:03.000Z"),
		);
		expect(failed.job).toMatchObject({
			state: "failed",
			lastError: "Twillot schema changed",
		});
		expect(getTwillotCompanionStatus(db).lastError).toBe(
			"Twillot schema changed",
		);
	});
});
