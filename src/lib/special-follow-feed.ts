import { getReadDb } from "./db";
import { createProfilePrioritySnapshot } from "./profile-priority";
import type { Database } from "./sqlite";
import {
	getSpecialFollowPosition,
	getValidSpecialFollowAnchor,
} from "./special-follow-position";
import { listTimelineItems } from "./timeline-read-model";
import type {
	SpecialFollowCursor,
	SpecialFollowFeedMode,
	SpecialFollowFeedResponse,
	SpecialFollowReadPosition,
	TimelineItem,
} from "./types";

export interface SpecialFollowFeedInput {
	accountId: string;
	mode?: SpecialFollowFeedMode;
	limit?: number;
	cursorCreatedAt?: string;
	cursorTweetId?: string;
}

function cursorFor(item: TimelineItem | undefined): SpecialFollowCursor | null {
	return item ? { createdAt: item.createdAt, tweetId: item.id } : null;
}

function specialFollowQuery(
	db: Database,
	accountId: string,
	filters: {
		limit: number;
		until?: string;
		untilId?: string;
		after?: string;
		afterId?: string;
		tweetId?: string;
		order?: "newest" | "oldest";
	},
) {
	const priorities = createProfilePrioritySnapshot(db);
	return listTimelineItems({
		resource: "home",
		account: accountId,
		priorityProfileIds: priorities.priorityProfileIds,
		priorityHandleOnlyHandles: priorities.priorityHandleOnlyHandles,
		priorityOnly: true,
		...filters,
	});
}

function profileCount(db: Database) {
	return createProfilePrioritySnapshot(db).rows.filter(
		(row) => row.isSpecialFollow === 1,
	).length;
}

function newestPage(
	db: Database,
	input: SpecialFollowFeedInput,
	mode: "newest" | "resume",
): SpecialFollowFeedResponse {
	const limit = input.limit ?? 18;
	const fetched = specialFollowQuery(db, input.accountId, { limit: limit + 1 });
	const hasOlder = fetched.length > limit;
	const items = fetched.slice(0, limit);
	return {
		items,
		specialFollowProfileCount: profileCount(db),
		page: {
			mode,
			hasNewer: false,
			hasOlder,
			newerCursor: cursorFor(items[0]),
			olderCursor: cursorFor(items.at(-1)),
			restore: null,
		},
	};
}

function cursorPage(
	db: Database,
	input: SpecialFollowFeedInput,
	mode: "newer" | "older",
): SpecialFollowFeedResponse {
	const limit = input.limit ?? 18;
	const cursorCreatedAt = input.cursorCreatedAt as string;
	const cursorTweetId = input.cursorTweetId as string;
	const fetched =
		mode === "older"
			? specialFollowQuery(db, input.accountId, {
					limit: limit + 1,
					until: cursorCreatedAt,
					untilId: cursorTweetId,
				})
			: specialFollowQuery(db, input.accountId, {
					limit: limit + 1,
					after: cursorCreatedAt,
					afterId: cursorTweetId,
					order: "oldest",
				});
	const hasMore = fetched.length > limit;
	const sliced = fetched.slice(0, limit);
	const items = mode === "newer" ? sliced.reverse() : sliced;
	return {
		items,
		specialFollowProfileCount: profileCount(db),
		page: {
			mode,
			hasNewer: mode === "newer" ? hasMore : true,
			hasOlder: mode === "older" ? hasMore : true,
			newerCursor: cursorFor(items[0]),
			olderCursor: cursorFor(items.at(-1)),
			restore: null,
		},
	};
}

function resolveAnchor(
	db: Database,
	accountId: string,
	position: SpecialFollowReadPosition,
) {
	const exact = getValidSpecialFollowAnchor(
		accountId,
		position.anchorTweetId,
		db,
	);
	if (exact) return { ...exact, exact: true };

	const older = specialFollowQuery(db, accountId, {
		limit: 1,
		until: position.anchorCreatedAt,
		untilId: position.anchorTweetId,
	})[0];
	if (older) {
		return { tweetId: older.id, createdAt: older.createdAt, exact: false };
	}
	const newer = specialFollowQuery(db, accountId, {
		limit: 1,
		after: position.anchorCreatedAt,
		afterId: position.anchorTweetId,
		order: "oldest",
	})[0];
	return newer
		? { tweetId: newer.id, createdAt: newer.createdAt, exact: false }
		: null;
}

function resumedPage(
	db: Database,
	input: SpecialFollowFeedInput,
): SpecialFollowFeedResponse {
	const position = getSpecialFollowPosition(input.accountId, db).position;
	if (!position) return newestPage(db, input, "resume");
	const resolved = resolveAnchor(db, input.accountId, position);
	if (!resolved) {
		const fallback = newestPage(db, input, "resume");
		return {
			...fallback,
			page: {
				...fallback.page,
				restore: {
					requestedTweetId: position.anchorTweetId,
					resolvedTweetId: null,
					createdAt: position.anchorCreatedAt,
					pixelOffset: position.pixelOffset,
					exact: false,
				},
			},
		};
	}

	const limit = input.limit ?? 18;
	const newerLimit = Math.floor((limit - 1) / 2);
	const olderLimit = limit - 1 - newerLimit;
	const anchor = specialFollowQuery(db, input.accountId, {
		limit: 1,
		tweetId: resolved.tweetId,
	})[0];
	if (!anchor) return newestPage(db, input, "resume");
	const newerFetched = specialFollowQuery(db, input.accountId, {
		limit: newerLimit + 1,
		after: anchor.createdAt,
		afterId: anchor.id,
		order: "oldest",
	});
	const olderFetched = specialFollowQuery(db, input.accountId, {
		limit: olderLimit + 1,
		until: anchor.createdAt,
		untilId: anchor.id,
	});
	const hasNewer = newerFetched.length > newerLimit;
	const hasOlder = olderFetched.length > olderLimit;
	const newer = newerFetched.slice(0, newerLimit).reverse();
	const older = olderFetched.slice(0, olderLimit);
	const items = [...newer, anchor, ...older];
	return {
		items,
		specialFollowProfileCount: profileCount(db),
		page: {
			mode: "resume",
			hasNewer,
			hasOlder,
			newerCursor: cursorFor(items[0]),
			olderCursor: cursorFor(items.at(-1)),
			restore: {
				requestedTweetId: position.anchorTweetId,
				resolvedTweetId: anchor.id,
				createdAt: anchor.createdAt,
				// A fallback row is a different card, so carrying the old card's
				// within-card offset would land at an arbitrary reading point.
				pixelOffset: resolved.exact ? position.pixelOffset : 0,
				exact: resolved.exact,
			},
		},
	};
}

export function listSpecialFollowFeed(
	input: SpecialFollowFeedInput,
	db: Database = getReadDb({ seedDemoData: false }),
): SpecialFollowFeedResponse {
	const mode = input.mode ?? "resume";
	if (mode === "newer" || mode === "older") {
		if (!input.cursorCreatedAt || !input.cursorTweetId) {
			throw new Error("A complete special-follow feed cursor is required.");
		}
		return cursorPage(db, input, mode);
	}
	return mode === "resume"
		? resumedPage(db, input)
		: newestPage(db, input, "newest");
}
