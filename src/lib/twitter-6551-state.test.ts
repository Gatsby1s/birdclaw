// @vitest-environment node
import { describe, expect, it } from "vitest";
import { useTestHome } from "../test/test-home";
import { getImportRepository } from "./import-repository";
import {
	claimTwitter6551PaidFallback,
	readTwitter6551DailyBudget,
	readTwitter6551FallbackState,
	recordTwitter6551FxRecovery,
	reserveTwitter6551RequestAttempt,
	Twitter6551RequestBudgetError,
} from "./twitter-6551-state";

describe("6551 durable recovery limits", () => {
	const getHome = useTestHome({ prefix: "birdclaw-6551-state-" });

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
		const threshold = claimTwitter6551PaidFallback(
			db,
			accountId,
			scope,
			3,
			360 * 60_000,
			at(30),
		);
		expect(threshold).toMatchObject({ claimed: false, reason: "threshold" });

		recordTwitter6551FxRecovery(
			db,
			accountId,
			scope,
			"total_failure",
			at(60),
			intervalMs,
		);
		const claimed = claimTwitter6551PaidFallback(
			db,
			accountId,
			scope,
			3,
			360 * 60_000,
			at(60),
		);
		expect(claimed).toMatchObject({
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

	it("fails closed when persisted budget state cannot be validated", () => {
		const { db } = getHome();
		db.prepare(
			`insert into twitter6551_paid_daily_usage
			 (usage_day, request_attempts, updated_at) values (?, ?, ?)`,
		).run("2026-08-15", "corrupt", "2026-08-15T00:00:00.000Z");
		expect(() =>
			readTwitter6551DailyBudget(db, 24, new Date("2026-08-15T12:00:00.000Z")),
		).toThrow(Twitter6551RequestBudgetError);
	});
});
