import type { Database } from "./sqlite";

interface StoredDailyBudget {
	usage_day: string;
	request_attempts: number;
}

interface StoredFallbackState {
	scope: string;
	consecutive_fx_total_failures: number;
	last_counted_fx_failure_at: string | null;
	last_paid_fallback_at: string | null;
}

export interface Twitter6551DailyBudgetStatus {
	day: string;
	attempts: number;
	limit: number;
	remaining: number;
}

export interface Twitter6551FallbackState {
	scope: string;
	consecutiveFxTotalFailures: number;
	lastCountedFxFailureAt: string | null;
	lastPaidFallbackAt: string | null;
}

export class Twitter6551RequestBudgetError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "Twitter6551RequestBudgetError";
	}
}

export class Twitter6551RecoveryStateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "Twitter6551RecoveryStateError";
	}
}

function nonNegativeInteger(value: number, label: string) {
	if (!Number.isInteger(value) || value < 0) {
		throw new Error(`${label} must be a non-negative integer`);
	}
	return value;
}

export function twitter6551UsageDay(now = new Date()) {
	return now.toISOString().slice(0, 10);
}

export function readTwitter6551DailyBudget(
	db: Database,
	limit: number,
	now = new Date(),
): Twitter6551DailyBudgetStatus {
	const normalizedLimit = nonNegativeInteger(limit, "daily request budget");
	const day = twitter6551UsageDay(now);
	try {
		const row = db
			.prepare(
				`select usage_day, request_attempts
				 from twitter6551_paid_daily_usage
				 where usage_day = ?`,
			)
			.get(day) as StoredDailyBudget | undefined;
		const attempts = row
			? nonNegativeInteger(row.request_attempts, "stored request attempts")
			: 0;
		if (row && row.usage_day !== day) throw new Error("invalid usage day");
		return {
			day,
			attempts,
			limit: normalizedLimit,
			remaining: Math.max(0, normalizedLimit - attempts),
		};
	} catch (error) {
		if (error instanceof Twitter6551RequestBudgetError) throw error;
		throw new Twitter6551RequestBudgetError(
			"6551 paid request budget could not be verified; requests are blocked",
		);
	}
}

export function reserveTwitter6551RequestAttempt(
	db: Database,
	limit: number,
	now = new Date(),
): Twitter6551DailyBudgetStatus {
	return db.transaction(() => {
		const current = readTwitter6551DailyBudget(db, limit, now);
		if (current.attempts >= current.limit) {
			throw new Twitter6551RequestBudgetError(
				`6551 paid daily request budget exhausted (${String(current.attempts)}/${String(current.limit)} UTC ${current.day}); requests are blocked`,
			);
		}
		const attempts = current.attempts + 1;
		db.prepare(
			`insert into twitter6551_paid_daily_usage (
				usage_day, request_attempts, updated_at
			 ) values (?, ?, ?)
			 on conflict(usage_day) do update set
				request_attempts = excluded.request_attempts,
				updated_at = excluded.updated_at`,
		).run(current.day, attempts, now.toISOString());
		return {
			...current,
			attempts,
			remaining: current.limit - attempts,
		};
	})();
}

function validIsoTimestamp(value: unknown) {
	if (value === null) return null;
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
		throw new Error("invalid timestamp");
	}
	return new Date(value).toISOString();
}

export function readTwitter6551FallbackState(
	db: Database,
	accountId: string,
	scope: string,
): Twitter6551FallbackState {
	try {
		const row = db
			.prepare(
				`select scope, consecutive_fx_total_failures,
					last_counted_fx_failure_at,
					last_paid_fallback_at
				 from twitter6551_recovery_state
				 where account_id = ?`,
			)
			.get(accountId) as StoredFallbackState | undefined;
		if (!row) {
			return {
				scope,
				consecutiveFxTotalFailures: 0,
				lastCountedFxFailureAt: null,
				lastPaidFallbackAt: null,
			};
		}
		const lastPaidFallbackAt = validIsoTimestamp(row.last_paid_fallback_at);
		const lastCountedFxFailureAt = validIsoTimestamp(
			row.last_counted_fx_failure_at,
		);
		if (row.scope !== scope) {
			return {
				scope,
				consecutiveFxTotalFailures: 0,
				lastCountedFxFailureAt: null,
				lastPaidFallbackAt,
			};
		}
		return {
			scope,
			consecutiveFxTotalFailures: nonNegativeInteger(
				row.consecutive_fx_total_failures,
				"stored Fx failure count",
			),
			lastCountedFxFailureAt,
			lastPaidFallbackAt,
		};
	} catch (error) {
		if (error instanceof Twitter6551RecoveryStateError) throw error;
		throw new Twitter6551RecoveryStateError(
			"6551 paid fallback state could not be verified; paid recovery is blocked",
		);
	}
}

function writeFallbackState(
	db: Database,
	accountId: string,
	state: Twitter6551FallbackState,
	now: Date,
) {
	db.prepare(
		`insert into twitter6551_recovery_state (
			account_id, scope, consecutive_fx_total_failures,
			last_counted_fx_failure_at,
			last_paid_fallback_at, updated_at
		 ) values (?, ?, ?, ?, ?, ?)
		 on conflict(account_id) do update set
			scope = excluded.scope,
			consecutive_fx_total_failures = excluded.consecutive_fx_total_failures,
			last_counted_fx_failure_at = excluded.last_counted_fx_failure_at,
			last_paid_fallback_at = excluded.last_paid_fallback_at,
			updated_at = excluded.updated_at`,
	).run(
		accountId,
		state.scope,
		state.consecutiveFxTotalFailures,
		state.lastCountedFxFailureAt,
		state.lastPaidFallbackAt,
		now.toISOString(),
	);
	return state;
}

export function recordTwitter6551FxRecovery(
	db: Database,
	accountId: string,
	scope: string,
	outcome: "success" | "partial" | "total_failure",
	now = new Date(),
	minimumFailureIntervalMs = 0,
) {
	return db.transaction(() => {
		const current = readTwitter6551FallbackState(db, accountId, scope);
		const lastFailureMs = current.lastCountedFxFailureAt
			? Date.parse(current.lastCountedFxFailureAt)
			: 0;
		const shouldCountFailure =
			outcome === "total_failure" &&
			(!lastFailureMs ||
				now.getTime() - lastFailureMs >= minimumFailureIntervalMs);
		return writeFallbackState(
			db,
			accountId,
			{
				...current,
				consecutiveFxTotalFailures: shouldCountFailure
					? current.consecutiveFxTotalFailures + 1
					: outcome === "total_failure"
						? current.consecutiveFxTotalFailures
						: 0,
				lastCountedFxFailureAt:
					outcome === "total_failure"
						? shouldCountFailure
							? now.toISOString()
							: current.lastCountedFxFailureAt
						: null,
			},
			now,
		);
	})();
}

export function claimTwitter6551PaidFallback(
	db: Database,
	accountId: string,
	scope: string,
	failureThreshold: number,
	cooldownMs: number,
	now = new Date(),
) {
	return db.transaction(() => {
		const current = readTwitter6551FallbackState(db, accountId, scope);
		if (current.consecutiveFxTotalFailures < failureThreshold) {
			return {
				claimed: false as const,
				reason: "threshold" as const,
				state: current,
			};
		}
		if (
			current.lastPaidFallbackAt &&
			now.getTime() - Date.parse(current.lastPaidFallbackAt) < cooldownMs
		) {
			return {
				claimed: false as const,
				reason: "cooldown" as const,
				state: current,
			};
		}
		const state = writeFallbackState(
			db,
			accountId,
			{
				...current,
				consecutiveFxTotalFailures: 0,
				lastCountedFxFailureAt: null,
				lastPaidFallbackAt: now.toISOString(),
			},
			now,
		);
		return { claimed: true as const, reason: null, state };
	})();
}
