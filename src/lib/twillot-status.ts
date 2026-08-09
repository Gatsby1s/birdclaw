import type { TwillotProviderStatus } from "./api-contracts";
import { getTwillotCompanionStatus } from "./twillot-companion";
import {
	DEFAULT_TWILLOT_DAILY_LIMIT,
	getTwillotHistoryQueueSnapshot,
} from "./twillot-history-queue";
import type { Database } from "./sqlite";
import { getTwillotFollowSyncStatus } from "./twillot-follow-scheduler";

export function getTwillotProviderStatus(
	db: Database,
	now: Date = new Date(),
): TwillotProviderStatus {
	const queue = getTwillotHistoryQueueSnapshot(db, {
		dailyLimit: DEFAULT_TWILLOT_DAILY_LIMIT,
		now,
		limit: 100,
	});
	const companion = getTwillotCompanionStatus(db, now);
	const followDetection = getTwillotFollowSyncStatus(db);
	return {
		plan: "Mini",
		monthlyPriceUsd: 4.99,
		dailyLimit: queue.dailyLimit,
		softBudget: true,
		usageDay: queue.usageDay,
		capturedToday: queue.downloadedToday,
		reservedToday: queue.reservedToday,
		remainingToday: queue.remainingToday,
		nextResetAt: queue.nextResetAt,
		nextEligibleAt: queue.nextEligibleAt,
		totalImported: queue.totalImported,
		queueCounts: {
			queued: queue.states.queued,
			active: queue.activeLeases,
			deferred: queue.states.deferred,
			caughtUpUnverified: queue.captureStatuses.caught_up_unverified,
			verifiedComplete: queue.captureStatuses.verified_complete,
			needsAttention: queue.captureStatuses.needs_attention,
		},
		companion: {
			paired: companion.paired,
			connected: companion.connected,
			tokenCreatedAt: companion.tokenCreatedAt,
			lastSeenAt: companion.lastSeenAt,
			lastError: companion.lastError,
		},
		followDetection,
		jobs: queue.jobs.map((job) => ({
			id: job.id,
			handle: job.handle,
			state: job.state,
			captureStatus: job.captureStatus,
			nextRunAt: job.nextRunAt,
			downloadedCount: job.downloadedCount,
			importedCount: job.importedCount,
			attemptCount: job.attemptCount,
			lastError: job.lastError,
			updatedAt: job.updatedAt,
		})),
		limitations: {
			vendorStartRequiresUser: true,
			providerRemainingUnknown: true,
			caughtUpRequiresVerification: true,
		},
	};
}
