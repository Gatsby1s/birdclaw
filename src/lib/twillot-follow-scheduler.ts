import { getNativeDb, getReadDb } from "./db";
import { syncFollowGraph } from "./follow-graph";
import { getTwillotCompanionStatus } from "./twillot-companion";
import type { Database } from "./sqlite";

const DEFAULT_INTERVAL_MS = 6 * 60 * 60_000;
const MIN_INTERVAL_MS = 60 * 60_000;
const INITIAL_DELAY_MS = 20_000;
const PAIRING_POLL_MS = 60_000;
const ERROR_RETRY_MS = 5 * 60_000;

export interface TwillotFollowSyncStatus {
	enabled: boolean;
	running: boolean;
	intervalMinutes: number;
	lastStartedAt: string | null;
	lastSuccessAt: string | null;
	lastError: string | null;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let interval: ReturnType<typeof setInterval> | null = null;
let running = false;

function intervalMs() {
	const minutes = Number(
		process.env.BIRDCLAW_TWILLOT_FOLLOW_SYNC_INTERVAL_MINUTES,
	);
	if (!Number.isFinite(minutes) || minutes <= 0) return DEFAULT_INTERVAL_MS;
	return Math.max(MIN_INTERVAL_MS, Math.floor(minutes * 60_000));
}

function configuredEnabled() {
	return process.env.BIRDCLAW_TWILLOT_FOLLOW_SYNC_ENABLED !== "0";
}

function stateRow(db: Database) {
	return db
		.prepare(
			`select last_started_at, last_success_at, last_error
			 from twillot_follow_sync_state where id = 1`,
		)
		.get() as
		| {
				last_started_at: string | null;
				last_success_at: string | null;
				last_error: string | null;
		  }
		| undefined;
}

function writeState(
	db: Database,
	input: {
		lastStartedAt: string;
		lastSuccessAt?: string | null;
		lastError?: string | null;
	},
) {
	db.prepare(
		`
    insert into twillot_follow_sync_state (
      id, last_started_at, last_success_at, last_error
    ) values (1, ?, ?, ?)
    on conflict(id) do update set
      last_started_at = excluded.last_started_at,
      last_success_at = coalesce(excluded.last_success_at, last_success_at),
      last_error = excluded.last_error
    `,
	).run(
		input.lastStartedAt,
		input.lastSuccessAt ?? null,
		input.lastError ?? null,
	);
}

export function getTwillotFollowSyncStatus(
	db: Database = getReadDb({ seedDemoData: false }),
): TwillotFollowSyncStatus {
	const row = stateRow(db);
	return {
		enabled: configuredEnabled() && getTwillotCompanionStatus(db).paired,
		running,
		intervalMinutes: Math.floor(intervalMs() / 60_000),
		lastStartedAt: row?.last_started_at ?? null,
		lastSuccessAt: row?.last_success_at ?? null,
		lastError: row?.last_error ?? null,
	};
}

export async function runTwillotFollowSyncOnce(
	options: {
		now?: Date;
		sync?: typeof syncFollowGraph;
		db?: Database;
	} = {},
) {
	if (running)
		return { ok: false as const, skipped: "already-running" as const };
	const db = options.db ?? getNativeDb({ seedDemoData: false });
	if (!configuredEnabled() || !getTwillotCompanionStatus(db).paired) {
		return { ok: false as const, skipped: "not-paired" as const };
	}
	running = true;
	const now = options.now ?? new Date();
	const startedAt = now.toISOString();
	writeState(db, { lastStartedAt: startedAt, lastError: null });
	try {
		const result = await (options.sync ?? syncFollowGraph)({
			direction: "following",
			mode: "auto",
			yes: true,
			refresh: true,
			allowPartial: false,
		});
		if ("partial" in result && result.partial) {
			throw new Error(
				"Automatic following refresh returned an incomplete snapshot",
			);
		}
		const completedAt = new Date().toISOString();
		writeState(db, {
			lastStartedAt: startedAt,
			lastSuccessAt: completedAt,
			lastError: null,
		});
		return { ok: true as const, result };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		writeState(db, { lastStartedAt: startedAt, lastError: message });
		return { ok: false as const, error: message };
	} finally {
		running = false;
	}
}

async function runTwillotFollowSyncIfDue() {
	const db = getNativeDb({ seedDemoData: false });
	if (!configuredEnabled() || !getTwillotCompanionStatus(db).paired) return;
	const row = stateRow(db);
	const lastStartedMs = row?.last_started_at
		? Date.parse(row.last_started_at)
		: Number.NaN;
	const retryAfterMs = row?.last_error ? ERROR_RETRY_MS : intervalMs();
	if (
		Number.isFinite(lastStartedMs) &&
		Date.now() - lastStartedMs < retryAfterMs
	) {
		return;
	}
	await runTwillotFollowSyncOnce({ db });
}

export function startTwillotFollowScheduler() {
	if (timer || interval) return;
	timer = setTimeout(() => {
		timer = null;
		void runTwillotFollowSyncIfDue();
	}, INITIAL_DELAY_MS);
	timer.unref?.();
	interval = setInterval(() => {
		void runTwillotFollowSyncIfDue();
	}, PAIRING_POLL_MS);
	interval.unref?.();
}

export function stopTwillotFollowScheduler() {
	if (timer) clearTimeout(timer);
	if (interval) clearInterval(interval);
	timer = null;
	interval = null;
}

export const __test__ = {
	configuredEnabled,
	intervalMs,
	runTwillotFollowSyncIfDue,
};
