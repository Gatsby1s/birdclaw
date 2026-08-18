import type { Database } from "./sqlite";

export const TWITTER6551_STATE_EVENT_TYPE =
	"BIRDCLAW_RESERVED_INTERNAL_STATE_V1";
export const TWITTER6551_STATE_WATCH_USER = "__birdclaw_internal_state__";
export const TWITTER6551_STATE_EVENT_PREFIX =
	"__birdclaw:twitter6551:state:v1:";

const DAILY_BUDGET_KIND = "paid_daily_usage";
const FALLBACK_STATE_KIND = "fallback_state";
const LEGACY_DAILY_BUDGET_TABLE = "twitter6551_paid_daily_usage";
const LEGACY_FALLBACK_STATE_TABLE = "twitter6551_recovery_state";
const LEGACY_SCHEMA_VERSION = 18;
const CURRENT_SCHEMA_VERSION = 20;

interface StoredStateEvent {
	event_id: string;
	event_type: string;
	watch_user: string;
	tweet_id: string | null;
	raw_json: string;
	received_at: string;
	processed_at: string | null;
	error: string | null;
}

interface StoredDailyBudget {
	version: 1;
	kind: typeof DAILY_BUDGET_KIND;
	day: string;
	attempts: number;
}

interface StoredFallbackState {
	version: 1;
	kind: typeof FALLBACK_STATE_KIND;
	accountId: string;
	scope: string;
	consecutiveFxTotalFailures: number;
	lastCountedFxFailureAt: string | null;
	lastPaidFallbackAt: string | null;
}

interface LegacyDailyBudgetRow {
	usage_day: string;
	request_attempts: number;
	updated_at: string;
}

interface LegacyFallbackStateRow {
	account_id: string;
	scope: string;
	consecutive_fx_total_failures: number;
	last_counted_fx_failure_at: string | null;
	last_paid_fallback_at: string | null;
	updated_at: string;
}

interface LegacyTableColumn {
	cid: number;
	name: string;
	type: string;
	notnull: number;
	dflt_value: string | null;
	pk: number;
}

interface ExpectedLegacyTableColumn {
	name: string;
	type: "TEXT" | "INTEGER";
	notnull: 0 | 1;
	dfltValue: string | null;
	pk: 0 | 1;
}

const LEGACY_DAILY_BUDGET_COLUMNS: readonly ExpectedLegacyTableColumn[] = [
	{ name: "usage_day", type: "TEXT", notnull: 0, dfltValue: null, pk: 1 },
	{
		name: "request_attempts",
		type: "INTEGER",
		notnull: 1,
		dfltValue: "0",
		pk: 0,
	},
	{ name: "updated_at", type: "TEXT", notnull: 1, dfltValue: null, pk: 0 },
];

const LEGACY_FALLBACK_STATE_COLUMNS: readonly ExpectedLegacyTableColumn[] = [
	{ name: "account_id", type: "TEXT", notnull: 0, dfltValue: null, pk: 1 },
	{ name: "scope", type: "TEXT", notnull: 1, dfltValue: null, pk: 0 },
	{
		name: "consecutive_fx_total_failures",
		type: "INTEGER",
		notnull: 1,
		dfltValue: "0",
		pk: 0,
	},
	{
		name: "last_counted_fx_failure_at",
		type: "TEXT",
		notnull: 0,
		dfltValue: null,
		pk: 0,
	},
	{
		name: "last_paid_fallback_at",
		type: "TEXT",
		notnull: 0,
		dfltValue: null,
		pk: 0,
	},
	{ name: "updated_at", type: "TEXT", notnull: 1, dfltValue: null, pk: 0 },
];

const LEGACY_DAILY_BUDGET_SQL = `
	create table twitter6551_paid_daily_usage (
		usage_day text primary key,
		request_attempts integer not null default 0
			check (request_attempts >= 0),
		updated_at text not null
	)
`;

const LEGACY_FALLBACK_STATE_SQL = `
	create table twitter6551_recovery_state (
		account_id text primary key,
		scope text not null,
		consecutive_fx_total_failures integer not null default 0
			check (consecutive_fx_total_failures >= 0),
		last_counted_fx_failure_at text,
		last_paid_fallback_at text,
		updated_at text not null
	)
`;

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
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${label} must be a non-negative integer`);
	}
	return value;
}

function validateLegacyTableSchema(
	db: Database,
	tableName:
		| typeof LEGACY_DAILY_BUDGET_TABLE
		| typeof LEGACY_FALLBACK_STATE_TABLE,
	expected: readonly ExpectedLegacyTableColumn[],
	expectedSql: string,
) {
	const schemaVersion = Number(db.pragma("user_version", { simple: true }));
	if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 0) {
		throw new Error("invalid database schema version");
	}
	if (schemaVersion > CURRENT_SCHEMA_VERSION) {
		throw new Error("unknown database schema version");
	}
	const table = db
		.prepare(
			`select sql from sqlite_master
			 where type = 'table' and name = ?`,
		)
		.get(tableName) as { sql: string | null } | undefined;
	if (!table) {
		if (schemaVersion === LEGACY_SCHEMA_VERSION) {
			throw new Error(`missing legacy ${tableName} table`);
		}
		return false;
	}
	const normalizeSql = (value: string) =>
		value.replace(/\s+/g, " ").trim().toLowerCase();
	if (
		typeof table.sql !== "string" ||
		normalizeSql(table.sql) !== normalizeSql(expectedSql)
	) {
		throw new Error(`invalid legacy ${tableName} schema`);
	}
	const columns = db.prepare(`pragma table_info(${tableName})`).all() as
		| LegacyTableColumn[]
		| undefined;
	if (!columns || columns.length !== expected.length) {
		throw new Error(`invalid legacy ${tableName} schema`);
	}
	for (const [index, expectedColumn] of expected.entries()) {
		const column = columns[index];
		if (
			!column ||
			column.cid !== index ||
			column.name !== expectedColumn.name ||
			column.type.toUpperCase() !== expectedColumn.type ||
			column.notnull !== expectedColumn.notnull ||
			column.dflt_value !== expectedColumn.dfltValue ||
			column.pk !== expectedColumn.pk
		) {
			throw new Error(`invalid legacy ${tableName} schema`);
		}
	}
	return true;
}

function ensureTwitter6551StateStorage(db: Database) {
	db.exec(`
		create table if not exists twitter6551_events (
			event_id text primary key,
			event_type text not null,
			watch_user text not null,
			tweet_id text,
			raw_json text not null,
			received_at text not null,
			processed_at text,
			error text
		);
		create index if not exists idx_twitter6551_events_pending
			on twitter6551_events(processed_at, received_at);
	`);
}

function dailyBudgetEventId(day: string) {
	return `${TWITTER6551_STATE_EVENT_PREFIX}budget:${day}`;
}

function fallbackStateEventId(accountId: string) {
	return `${TWITTER6551_STATE_EVENT_PREFIX}fallback:${encodeURIComponent(accountId)}`;
}

function validIsoTimestamp(value: unknown) {
	if (value === null) return null;
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
		throw new Error("invalid timestamp");
	}
	const normalized = new Date(value).toISOString();
	if (normalized !== value) throw new Error("timestamp must be canonical ISO");
	return normalized;
}

function readStateEvent(db: Database, eventId: string) {
	ensureTwitter6551StateStorage(db);
	const row = db
		.prepare(
			`select event_id, event_type, watch_user, tweet_id, raw_json,
				received_at, processed_at, error
			 from twitter6551_events
			 where event_id = ?`,
		)
		.get(eventId) as StoredStateEvent | undefined;
	if (!row) return null;
	if (
		row.event_id !== eventId ||
		row.event_type !== TWITTER6551_STATE_EVENT_TYPE ||
		row.watch_user !== TWITTER6551_STATE_WATCH_USER ||
		row.tweet_id !== null ||
		row.processed_at === null ||
		row.error !== null
	) {
		throw new Error("invalid reserved state event metadata");
	}
	validIsoTimestamp(row.received_at);
	validIsoTimestamp(row.processed_at);
	const parsed = JSON.parse(row.raw_json) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("invalid reserved state event payload");
	}
	return parsed as Record<string, unknown>;
}

function writeStateEvent(
	db: Database,
	eventId: string,
	payload: StoredDailyBudget | StoredFallbackState,
	now: Date,
) {
	ensureTwitter6551StateStorage(db);
	const timestamp = now.toISOString();
	db.prepare(
		`insert into twitter6551_events (
			event_id, event_type, watch_user, tweet_id, raw_json,
			received_at, processed_at, error
		 ) values (?, ?, ?, null, ?, ?, ?, null)
		 on conflict(event_id) do update set
			event_type = excluded.event_type,
			watch_user = excluded.watch_user,
			tweet_id = null,
			raw_json = excluded.raw_json,
			received_at = excluded.received_at,
			processed_at = excluded.processed_at,
			error = null`,
	).run(
		eventId,
		TWITTER6551_STATE_EVENT_TYPE,
		TWITTER6551_STATE_WATCH_USER,
		JSON.stringify(payload),
		timestamp,
		timestamp,
	);
}

function promoteLegacyDailyBudget(
	db: Database,
	day: string,
	now: Date,
): StoredDailyBudget | null {
	if (
		!validateLegacyTableSchema(
			db,
			LEGACY_DAILY_BUDGET_TABLE,
			LEGACY_DAILY_BUDGET_COLUMNS,
			LEGACY_DAILY_BUDGET_SQL,
		)
	) {
		return null;
	}
	const row = db
		.prepare(
			`select usage_day, request_attempts, updated_at
			 from twitter6551_paid_daily_usage
			 where usage_day = ?`,
		)
		.get(day) as LegacyDailyBudgetRow | undefined;
	if (!row) return null;
	if (row.usage_day !== day) throw new Error("invalid legacy usage day");
	const attempts = nonNegativeInteger(
		row.request_attempts,
		"legacy stored request attempts",
	);
	validIsoTimestamp(row.updated_at);
	const stored: StoredDailyBudget = {
		version: 1,
		kind: DAILY_BUDGET_KIND,
		day,
		attempts,
	};
	writeStateEvent(db, dailyBudgetEventId(day), stored, now);
	return stored;
}

function promoteLegacyFallbackState(
	db: Database,
	accountId: string,
	now: Date,
): StoredFallbackState | null {
	if (
		!validateLegacyTableSchema(
			db,
			LEGACY_FALLBACK_STATE_TABLE,
			LEGACY_FALLBACK_STATE_COLUMNS,
			LEGACY_FALLBACK_STATE_SQL,
		)
	) {
		return null;
	}
	const row = db
		.prepare(
			`select account_id, scope, consecutive_fx_total_failures,
				last_counted_fx_failure_at, last_paid_fallback_at, updated_at
			 from twitter6551_recovery_state
			 where account_id = ?`,
		)
		.get(accountId) as LegacyFallbackStateRow | undefined;
	if (!row) return null;
	if (row.account_id !== accountId || typeof row.scope !== "string") {
		throw new Error("invalid legacy fallback state identity");
	}
	const consecutiveFxTotalFailures = nonNegativeInteger(
		row.consecutive_fx_total_failures,
		"legacy stored Fx failure count",
	);
	const lastCountedFxFailureAt = validIsoTimestamp(
		row.last_counted_fx_failure_at,
	);
	const lastPaidFallbackAt = validIsoTimestamp(row.last_paid_fallback_at);
	validIsoTimestamp(row.updated_at);
	const stored: StoredFallbackState = {
		version: 1,
		kind: FALLBACK_STATE_KIND,
		accountId,
		scope: row.scope,
		consecutiveFxTotalFailures,
		lastCountedFxFailureAt,
		lastPaidFallbackAt,
	};
	writeStateEvent(db, fallbackStateEventId(accountId), stored, now);
	return stored;
}

export function twitter6551UsageDay(now = new Date()) {
	return now.toISOString().slice(0, 10);
}

export function readTwitter6551DailyBudget(
	db: Database,
	limit: number,
	now = new Date(),
): Twitter6551DailyBudgetStatus {
	try {
		const normalizedLimit = nonNegativeInteger(limit, "daily request budget");
		const day = twitter6551UsageDay(now);
		return db.transaction(() => {
			const row =
				readStateEvent(db, dailyBudgetEventId(day)) ??
				promoteLegacyDailyBudget(db, day, now);
			const stored = row as Partial<StoredDailyBudget> | null;
			if (
				stored &&
				(stored.version !== 1 ||
					stored.kind !== DAILY_BUDGET_KIND ||
					stored.day !== day)
			) {
				throw new Error("invalid paid daily usage payload");
			}
			const attempts = stored
				? nonNegativeInteger(
						stored.attempts as number,
						"stored request attempts",
					)
				: 0;
			return {
				day,
				attempts,
				limit: normalizedLimit,
				remaining: Math.max(0, normalizedLimit - attempts),
			};
		})();
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
		writeStateEvent(
			db,
			dailyBudgetEventId(current.day),
			{
				version: 1,
				kind: DAILY_BUDGET_KIND,
				day: current.day,
				attempts,
			},
			now,
		);
		return {
			...current,
			attempts,
			remaining: current.limit - attempts,
		};
	})();
}

export function readTwitter6551FallbackState(
	db: Database,
	accountId: string,
	scope: string,
	now = new Date(),
): Twitter6551FallbackState {
	try {
		return db.transaction(() => {
			const row =
				readStateEvent(db, fallbackStateEventId(accountId)) ??
				promoteLegacyFallbackState(db, accountId, now);
			if (!row) {
				return {
					scope,
					consecutiveFxTotalFailures: 0,
					lastCountedFxFailureAt: null,
					lastPaidFallbackAt: null,
				};
			}
			const stored = row as Partial<StoredFallbackState>;
			if (
				stored.version !== 1 ||
				stored.kind !== FALLBACK_STATE_KIND ||
				stored.accountId !== accountId ||
				typeof stored.scope !== "string"
			) {
				throw new Error("invalid fallback state payload");
			}
			const lastPaidFallbackAt = validIsoTimestamp(stored.lastPaidFallbackAt);
			const lastCountedFxFailureAt = validIsoTimestamp(
				stored.lastCountedFxFailureAt,
			);
			const consecutiveFxTotalFailures = nonNegativeInteger(
				stored.consecutiveFxTotalFailures as number,
				"stored Fx failure count",
			);
			if (stored.scope !== scope) {
				return {
					scope,
					consecutiveFxTotalFailures: 0,
					lastCountedFxFailureAt: null,
					lastPaidFallbackAt,
				};
			}
			return {
				scope,
				consecutiveFxTotalFailures,
				lastCountedFxFailureAt,
				lastPaidFallbackAt,
			};
		})();
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
	writeStateEvent(
		db,
		fallbackStateEventId(accountId),
		{
			version: 1,
			kind: FALLBACK_STATE_KIND,
			accountId,
			scope: state.scope,
			consecutiveFxTotalFailures: state.consecutiveFxTotalFailures,
			lastCountedFxFailureAt: state.lastCountedFxFailureAt,
			lastPaidFallbackAt: state.lastPaidFallbackAt,
		},
		now,
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
		const current = readTwitter6551FallbackState(db, accountId, scope, now);
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
		const current = readTwitter6551FallbackState(db, accountId, scope, now);
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
