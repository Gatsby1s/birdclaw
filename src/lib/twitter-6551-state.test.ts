// @vitest-environment node
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTestHome } from "../test/test-home";
import { getImportRepository } from "./import-repository";
import NativeSqliteDatabase, { type Database } from "./sqlite";
import {
	claimTwitter6551PaidFallback,
	readTwitter6551DailyBudget,
	readTwitter6551FallbackState,
	recordTwitter6551FxRecovery,
	reserveTwitter6551RequestAttempt,
	TWITTER6551_STATE_EVENT_PREFIX,
	TWITTER6551_STATE_EVENT_TYPE,
	TWITTER6551_STATE_WATCH_USER,
	Twitter6551RecoveryStateError,
	Twitter6551RequestBudgetError,
} from "./twitter-6551-state";

function createLegacyDailyBudgetTable(db: Database) {
	db.exec(`
		create table twitter6551_paid_daily_usage (
			usage_day text primary key,
			request_attempts integer not null default 0
				check (request_attempts >= 0),
			updated_at text not null
		);
	`);
}

function createLegacyFallbackStateTable(db: Database) {
	db.exec(`
		create table twitter6551_recovery_state (
			account_id text primary key,
			scope text not null,
			consecutive_fx_total_failures integer not null default 0
				check (consecutive_fx_total_failures >= 0),
			last_counted_fx_failure_at text,
			last_paid_fallback_at text,
			updated_at text not null
		);
	`);
}

describe("6551 durable recovery limits", () => {
	const getHome = useTestHome({ prefix: "birdclaw-6551-state-" });

	it("self-creates only the existing event inbox without changing schema version", () => {
		const db = new NativeSqliteDatabase(":memory:");
		try {
			db.exec("pragma user_version = 17");
			expect(readTwitter6551DailyBudget(db, 24)).toMatchObject({
				attempts: 0,
				remaining: 24,
			});
			expect(
				db
					.prepare("pragma table_info(twitter6551_events)")
					.all()
					.map((column) => (column as { name: string }).name),
			).toEqual([
				"event_id",
				"event_type",
				"watch_user",
				"tweet_id",
				"raw_json",
				"received_at",
				"processed_at",
				"error",
			]);
			expect(db.pragma("user_version", { simple: true })).toBe(17);
		} finally {
			db.close();
		}
	});

	it("fails closed when v18 legacy tables are missing or the schema is newer", () => {
		const now = new Date("2026-08-15T12:00:00.000Z");
		const missing = new NativeSqliteDatabase(":memory:");
		try {
			missing.exec("pragma user_version = 18");
			expect(() => readTwitter6551DailyBudget(missing, 24, now)).toThrow(
				Twitter6551RequestBudgetError,
			);
			expect(() =>
				readTwitter6551FallbackState(
					missing,
					"acct_missing",
					"scope-missing",
					now,
				),
			).toThrow(Twitter6551RecoveryStateError);
		} finally {
			missing.close();
		}

		const newer = new NativeSqliteDatabase(":memory:");
		try {
			createLegacyDailyBudgetTable(newer);
			newer.exec("pragma user_version = 19");
			expect(() => readTwitter6551DailyBudget(newer, 24, now)).toThrow(
				Twitter6551RequestBudgetError,
			);
		} finally {
			newer.close();
		}
	});

	it("stores unmistakable processed synthetic events outside the replay queue", () => {
		const { db } = getHome();
		const now = new Date("2026-08-15T12:00:00.000Z");
		reserveTwitter6551RequestAttempt(db, 24, now);
		recordTwitter6551FxRecovery(
			db,
			"acct/synthetic",
			"scope-synthetic",
			"total_failure",
			now,
		);

		const rows = db
			.prepare(
				`select event_id, event_type, watch_user, tweet_id,
					processed_at, error, raw_json
				 from twitter6551_events
				 where event_id like ?
				 order by event_id`,
			)
			.all(`${TWITTER6551_STATE_EVENT_PREFIX}%`) as Array<{
			event_id: string;
			event_type: string;
			watch_user: string;
			tweet_id: string | null;
			processed_at: string | null;
			error: string | null;
			raw_json: string;
		}>;
		expect(rows).toHaveLength(2);
		expect(rows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					event_id: `${TWITTER6551_STATE_EVENT_PREFIX}budget:2026-08-15`,
					event_type: TWITTER6551_STATE_EVENT_TYPE,
					watch_user: TWITTER6551_STATE_WATCH_USER,
					tweet_id: null,
					processed_at: now.toISOString(),
					error: null,
				}),
				expect.objectContaining({
					event_id: `${TWITTER6551_STATE_EVENT_PREFIX}fallback:acct%2Fsynthetic`,
					event_type: TWITTER6551_STATE_EVENT_TYPE,
					watch_user: TWITTER6551_STATE_WATCH_USER,
					tweet_id: null,
					processed_at: now.toISOString(),
					error: null,
				}),
			]),
		);
		expect(
			db
				.prepare(
					`select count(*) as count from twitter6551_events
					 where event_id like ? and processed_at is null`,
				)
				.get(`${TWITTER6551_STATE_EVENT_PREFIX}%`),
		).toEqual({ count: 0 });
		expect(rows.map((row) => JSON.parse(row.raw_json))).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ version: 1, kind: "paid_daily_usage" }),
				expect.objectContaining({ version: 1, kind: "fallback_state" }),
			]),
		);
	});

	it("atomically caps actual attempts and opens a fresh UTC day", () => {
		const { db } = getHome();
		const firstDay = new Date("2026-08-15T23:59:59.000Z");
		expect(readTwitter6551DailyBudget(db, 2, firstDay)).toEqual({
			day: "2026-08-15",
			attempts: 0,
			limit: 2,
			remaining: 2,
		});
		expect(reserveTwitter6551RequestAttempt(db, 2, firstDay).attempts).toBe(1);
		expect(reserveTwitter6551RequestAttempt(db, 2, firstDay)).toMatchObject({
			attempts: 2,
			remaining: 0,
		});
		expect(() => reserveTwitter6551RequestAttempt(db, 2, firstDay)).toThrow(
			Twitter6551RequestBudgetError,
		);
		expect(
			reserveTwitter6551RequestAttempt(
				db,
				2,
				new Date("2026-08-16T00:00:00.000Z"),
			),
		).toMatchObject({ day: "2026-08-16", attempts: 1, remaining: 1 });
	});

	it("promotes a v18 daily budget once without resetting used attempts", () => {
		const { db } = getHome();
		const now = new Date("2026-08-15T12:00:00.000Z");
		db.exec("pragma user_version = 18");
		createLegacyDailyBudgetTable(db);
		db.prepare(
			`insert into twitter6551_paid_daily_usage
			 (usage_day, request_attempts, updated_at) values (?, ?, ?)`,
		).run("2026-08-15", 7, "2026-08-15T11:00:00.000Z");

		expect(readTwitter6551DailyBudget(db, 24, now)).toEqual({
			day: "2026-08-15",
			attempts: 7,
			limit: 24,
			remaining: 17,
		});
		expect(
			db
				.prepare(
					`select raw_json, processed_at from twitter6551_events
					 where event_id = ?`,
				)
				.get(`${TWITTER6551_STATE_EVENT_PREFIX}budget:2026-08-15`),
		).toEqual({
			raw_json: JSON.stringify({
				version: 1,
				kind: "paid_daily_usage",
				day: "2026-08-15",
				attempts: 7,
			}),
			processed_at: now.toISOString(),
		});

		db.prepare(
			`update twitter6551_paid_daily_usage set request_attempts = 19
			 where usage_day = ?`,
		).run("2026-08-15");
		expect(readTwitter6551DailyBudget(db, 24, now).attempts).toBe(7);
		expect(db.pragma("user_version", { simple: true })).toBe(18);
	});

	it("persists debounced Fx failures and atomically claims paid cooldown", () => {
		const { db } = getHome();
		const accountId = "acct_state_machine";
		const scope = "scope-a";
		const intervalMs = 30 * 60_000;
		const at = (minutes: number) =>
			new Date(Date.parse("2026-08-15T00:00:00.000Z") + minutes * 60_000);

		recordTwitter6551FxRecovery(
			db,
			accountId,
			scope,
			"total_failure",
			at(0),
			intervalMs,
		);
		expect(
			recordTwitter6551FxRecovery(
				db,
				accountId,
				scope,
				"total_failure",
				at(1),
				intervalMs,
			).consecutiveFxTotalFailures,
		).toBe(1);
		recordTwitter6551FxRecovery(
			db,
			accountId,
			scope,
			"total_failure",
			at(30),
			intervalMs,
		);
		expect(
			claimTwitter6551PaidFallback(
				db,
				accountId,
				scope,
				3,
				360 * 60_000,
				at(30),
			),
		).toMatchObject({ claimed: false, reason: "threshold" });

		recordTwitter6551FxRecovery(
			db,
			accountId,
			scope,
			"total_failure",
			at(60),
			intervalMs,
		);
		expect(
			claimTwitter6551PaidFallback(
				db,
				accountId,
				scope,
				3,
				360 * 60_000,
				at(60),
			),
		).toMatchObject({
			claimed: true,
			state: {
				consecutiveFxTotalFailures: 0,
				lastPaidFallbackAt: at(60).toISOString(),
			},
		});

		for (const minute of [90, 120, 150]) {
			recordTwitter6551FxRecovery(
				db,
				accountId,
				scope,
				"total_failure",
				at(minute),
				intervalMs,
			);
		}
		expect(
			claimTwitter6551PaidFallback(
				db,
				accountId,
				scope,
				3,
				360 * 60_000,
				at(150),
			),
		).toMatchObject({ claimed: false, reason: "cooldown" });
		expect(
			claimTwitter6551PaidFallback(
				db,
				accountId,
				scope,
				3,
				360 * 60_000,
				at(420),
			),
		).toMatchObject({ claimed: true });
	});

	it("promotes a v18 fallback state and preserves its paid cooldown", () => {
		const { db } = getHome();
		const accountId = "acct_legacy_fallback";
		const scope = "scope-legacy";
		const now = new Date("2026-08-15T12:00:00.000Z");
		const lastFailureAt = "2026-08-15T10:30:00.000Z";
		const lastPaidAt = "2026-08-15T11:00:00.000Z";
		db.exec("pragma user_version = 18");
		createLegacyFallbackStateTable(db);
		db.prepare(
			`insert into twitter6551_recovery_state (
				account_id, scope, consecutive_fx_total_failures,
				last_counted_fx_failure_at, last_paid_fallback_at, updated_at
			 ) values (?, ?, ?, ?, ?, ?)`,
		).run(accountId, scope, 3, lastFailureAt, lastPaidAt, lastPaidAt);

		expect(readTwitter6551FallbackState(db, accountId, scope, now)).toEqual({
			scope,
			consecutiveFxTotalFailures: 3,
			lastCountedFxFailureAt: lastFailureAt,
			lastPaidFallbackAt: lastPaidAt,
		});
		expect(
			claimTwitter6551PaidFallback(db, accountId, scope, 3, 360 * 60_000, now),
		).toMatchObject({ claimed: false, reason: "cooldown" });

		db.prepare(
			`update twitter6551_recovery_state set
				consecutive_fx_total_failures = 0, last_paid_fallback_at = null
			 where account_id = ?`,
		).run(accountId);
		expect(
			readTwitter6551FallbackState(db, accountId, scope, now),
		).toMatchObject({
			consecutiveFxTotalFailures: 3,
			lastPaidFallbackAt: lastPaidAt,
		});
		expect(db.pragma("user_version", { simple: true })).toBe(18);
	});

	it("survives a database close and process-style reopen", () => {
		const home = getHome();
		const dbPath = path.join(
			home.makeTempDir("birdclaw-6551-restart-"),
			"state.sqlite",
		);
		const now = new Date("2026-08-15T12:00:00.000Z");
		const first = new NativeSqliteDatabase(dbPath);
		reserveTwitter6551RequestAttempt(first, 24, now);
		recordTwitter6551FxRecovery(
			first,
			"acct_restart",
			"scope-restart",
			"total_failure",
			now,
		);
		first.close();

		const reopened = new NativeSqliteDatabase(dbPath);
		try {
			expect(readTwitter6551DailyBudget(reopened, 24, now).attempts).toBe(1);
			expect(
				readTwitter6551FallbackState(reopened, "acct_restart", "scope-restart"),
			).toMatchObject({ consecutiveFxTotalFailures: 1 });
		} finally {
			reopened.close();
		}
	});

	it("keeps hard usage and fallback state across content-backup replacement", () => {
		const { db } = getHome();
		const now = new Date("2026-08-15T12:00:00.000Z");
		reserveTwitter6551RequestAttempt(db, 24, now);
		recordTwitter6551FxRecovery(
			db,
			"acct_backup",
			"scope-backup",
			"total_failure",
			now,
		);

		getImportRepository(db).clearBackupImport();

		expect(readTwitter6551DailyBudget(db, 24, now).attempts).toBe(1);
		expect(
			readTwitter6551FallbackState(db, "acct_backup", "scope-backup"),
		).toMatchObject({ consecutiveFxTotalFailures: 1 });
	});

	it("fails closed on corrupt synthetic payload or reserved metadata", () => {
		const { db } = getHome();
		const now = new Date("2026-08-15T12:00:00.000Z");
		reserveTwitter6551RequestAttempt(db, 24, now);
		db.prepare(
			`update twitter6551_events set raw_json = ?
			 where event_id = ?`,
		).run(
			JSON.stringify({ version: 1, kind: "paid_daily_usage", attempts: 1 }),
			`${TWITTER6551_STATE_EVENT_PREFIX}budget:2026-08-15`,
		);
		expect(() => readTwitter6551DailyBudget(db, 24, now)).toThrow(
			Twitter6551RequestBudgetError,
		);

		recordTwitter6551FxRecovery(
			db,
			"acct_corrupt",
			"scope-corrupt",
			"total_failure",
			now,
		);
		db.prepare(
			`update twitter6551_events set processed_at = null
			 where event_id = ?`,
		).run(`${TWITTER6551_STATE_EVENT_PREFIX}fallback:acct_corrupt`);
		expect(() =>
			readTwitter6551FallbackState(db, "acct_corrupt", "scope-corrupt"),
		).toThrow(Twitter6551RecoveryStateError);
	});

	it("fails closed on corrupt legacy rows, incomplete schemas, and event ID collisions", () => {
		const home = getHome();
		const now = new Date("2026-08-15T12:00:00.000Z");
		createLegacyDailyBudgetTable(home.db);
		home.db
			.prepare(
				`insert into twitter6551_paid_daily_usage
				 (usage_day, request_attempts, updated_at) values (?, ?, ?)`,
			)
			.run("2026-08-15", "corrupt", now.toISOString());
		expect(() => readTwitter6551DailyBudget(home.db, 24, now)).toThrow(
			Twitter6551RequestBudgetError,
		);

		const incomplete = new NativeSqliteDatabase(":memory:");
		try {
			incomplete.exec(`
				create table twitter6551_recovery_state (
					account_id text primary key,
					scope text not null
				);
			`);
			expect(() =>
				readTwitter6551FallbackState(
					incomplete,
					"acct_incomplete",
					"scope-incomplete",
					now,
				),
			).toThrow(Twitter6551RecoveryStateError);
		} finally {
			incomplete.close();
		}

		const collision = new NativeSqliteDatabase(":memory:");
		try {
			createLegacyDailyBudgetTable(collision);
			collision
				.prepare(
					`insert into twitter6551_paid_daily_usage
					 (usage_day, request_attempts, updated_at) values (?, ?, ?)`,
				)
				.run("2026-08-15", 7, now.toISOString());
			readTwitter6551FallbackState(
				collision,
				"bootstrap-events-table",
				"scope",
				now,
			);
			const eventId = `${TWITTER6551_STATE_EVENT_PREFIX}budget:2026-08-15`;
			collision
				.prepare(
					`insert into twitter6551_events (
						event_id, event_type, watch_user, tweet_id, raw_json, received_at
					 ) values (?, 'NEW_TWEET', 'real_user', 'tweet-1', '{}', ?)`,
				)
				.run(eventId, now.toISOString());
			expect(() => readTwitter6551DailyBudget(collision, 24, now)).toThrow(
				Twitter6551RequestBudgetError,
			);
			expect(
				collision
					.prepare(
						"select event_type, watch_user from twitter6551_events where event_id = ?",
					)
					.get(eventId),
			).toEqual({ event_type: "NEW_TWEET", watch_user: "real_user" });
		} finally {
			collision.close();
		}
	});

	it("rejects legacy tables whose published CHECK constraints are missing", () => {
		const now = new Date("2026-08-15T12:00:00.000Z");
		const budget = new NativeSqliteDatabase(":memory:");
		try {
			budget.exec(`
				pragma user_version = 18;
				create table twitter6551_paid_daily_usage (
					usage_day text primary key,
					request_attempts integer not null default 0,
					updated_at text not null
				);
			`);
			expect(() => readTwitter6551DailyBudget(budget, 24, now)).toThrow(
				Twitter6551RequestBudgetError,
			);
		} finally {
			budget.close();
		}

		const fallback = new NativeSqliteDatabase(":memory:");
		try {
			fallback.exec(`
				pragma user_version = 18;
				create table twitter6551_recovery_state (
					account_id text primary key,
					scope text not null,
					consecutive_fx_total_failures integer not null default 0,
					last_counted_fx_failure_at text,
					last_paid_fallback_at text,
					updated_at text not null
				);
			`);
			expect(() =>
				readTwitter6551FallbackState(
					fallback,
					"acct_no_check",
					"scope-no-check",
					now,
				),
			).toThrow(Twitter6551RecoveryStateError);
		} finally {
			fallback.close();
		}
	});
});
