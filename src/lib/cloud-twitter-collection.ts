import type { Database } from "./sqlite";
import {
	enqueueTwillotHistoryJob,
	type TwillotHistoryJob,
} from "./twillot-history-queue";

export interface CloudTwitterCollectionTarget {
	accountId: string;
	profileId: string;
	externalUserId: string | null;
	handle: string;
}

export type PreviousTwillotFallbackOutcome =
	| "none"
	| "pending"
	| "completed"
	| "failed";

function normalizeHandle(value: string) {
	return value.trim().replace(/^@/, "").toLowerCase();
}

export function listCloudFollowingTargets(db: Database) {
	const rows = db
		.prepare(
			`select e.account_id, e.profile_id, e.external_user_id, p.handle
			 from follow_edges e
			 join profiles p on p.id = e.profile_id
			 where e.direction = 'following' and e.current = 1
			 order by lower(p.handle), e.account_id`,
		)
		.all() as Array<{
		account_id: string;
		profile_id: string;
		external_user_id: string | null;
		handle: string;
	}>;
	const unique = new Map<string, CloudTwitterCollectionTarget>();
	for (const row of rows) {
		const key = normalizeHandle(row.handle);
		if (!key || unique.has(key)) continue;
		unique.set(key, {
			accountId: row.account_id,
			profileId: row.profile_id,
			externalUserId: row.external_user_id,
			handle: row.handle.replace(/^@/, ""),
		});
	}
	return [...unique.values()];
}

export function mergeCloudCollectionHandles(
	db: Database,
	configuredHandles: string[],
	includeFollowing: boolean,
) {
	const handles = new Map<string, string>();
	for (const handle of configuredHandles) {
		const normalized = normalizeHandle(handle);
		if (normalized) handles.set(normalized, handle.replace(/^@/, ""));
	}
	if (includeFollowing) {
		for (const target of listCloudFollowingTargets(db)) {
			handles.set(normalizeHandle(target.handle), target.handle);
		}
	}
	return [...handles.values()];
}

export function findCloudFollowingTarget(db: Database, handle: string) {
	const normalized = normalizeHandle(handle);
	return (
		listCloudFollowingTargets(db).find(
			(target) => normalizeHandle(target.handle) === normalized,
		) ?? null
	);
}

function getTwillotJobForTarget(
	db: Database,
	target: CloudTwitterCollectionTarget,
) {
	const row = db
		.prepare(
			`select * from twillot_history_jobs
			 where account_id = ? and profile_id = ? and provider = 'twillot'`,
		)
		.get(target.accountId, target.profileId) as
		| {
				id: string;
				account_id: string;
				profile_id: string;
				provider: string;
				external_user_id: string | null;
				handle: string;
				state: TwillotHistoryJob["state"];
				capture_status: TwillotHistoryJob["captureStatus"];
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
		| undefined;
	if (!row) return null;
	return {
		id: row.id,
		accountId: row.account_id,
		profileId: row.profile_id,
		provider: row.provider,
		externalUserId: row.external_user_id,
		handle: row.handle,
		state: row.state,
		captureStatus: row.capture_status,
		cursor: JSON.parse(row.cursor_json) as unknown,
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
	} satisfies TwillotHistoryJob;
}

export function evaluatePreviousTwillotFallback(
	db: Database,
	input: {
		target: CloudTwitterCollectionTarget;
		lastFxFailureAt: string | null;
		timeoutMs: number;
		now?: Date;
	},
): PreviousTwillotFallbackOutcome {
	if (!input.lastFxFailureAt) return "none";
	const failureMs = Date.parse(input.lastFxFailureAt);
	if (!Number.isFinite(failureMs)) return "failed";
	const job = getTwillotJobForTarget(db, input.target);
	if (!job) return "none";
	if (
		job.state === "completed" &&
		job.completedAt &&
		Date.parse(job.completedAt) >= failureMs
	) {
		return "completed";
	}
	if (job.state === "failed" && Date.parse(job.updatedAt) >= failureMs) {
		return "failed";
	}
	if (["queued", "leased", "deferred"].includes(job.state)) {
		return (input.now ?? new Date()).getTime() - failureMs >= input.timeoutMs
			? "failed"
			: "pending";
	}
	return "none";
}

export function queueTwillotFallback(
	db: Database,
	input: { target: CloudTwitterCollectionTarget; now?: Date },
) {
	if (!input.target.externalUserId) return null;
	const now = input.now ?? new Date();
	const existing = getTwillotJobForTarget(db, input.target);
	if (!existing) {
		return enqueueTwillotHistoryJob(db, {
			accountId: input.target.accountId,
			profileId: input.target.profileId,
			externalUserId: input.target.externalUserId,
			handle: input.target.handle,
			now,
		});
	}
	const nowIso = now.toISOString();
	db.prepare(
		`update twillot_history_jobs
		 set external_user_id = ?, handle = ?, state = 'queued',
		     capture_status = 'capture_requested', cursor_json = 'null',
		     next_run_at = ?, lease_token = null, lease_expires_at = null,
		     lease_usage_day = null, lease_allowance = 0, last_error = null,
		     updated_at = ?, completed_at = null
		 where id = ? and state in ('completed', 'failed')`,
	).run(
		input.target.externalUserId,
		input.target.handle,
		nowIso,
		nowIso,
		existing.id,
	);
	return getTwillotJobForTarget(db, input.target);
}
