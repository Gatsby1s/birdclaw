import { getReadDb } from "./db";
import { createProfileListSnapshot } from "./profile-lists";
import type { Database } from "./sqlite";
import { listTimelineItems } from "./timeline-read-model";
import type { ProfileListFeedResponse } from "./types";

export function listProfileListFeed(
	input: {
		accountId: string;
		listId: string;
		search?: string;
		until?: string;
		untilId?: string;
		limit?: number;
	},
	db: Database = getReadDb({ seedDemoData: false }),
): ProfileListFeedResponse {
	const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 30)));
	const snapshot = createProfileListSnapshot(input, db);
	const fetched = listTimelineItems({
		resource: "home",
		account: snapshot.list.accountId,
		search: input.search,
		until: input.until,
		untilId: input.untilId,
		priorityProfileIds: snapshot.priorityProfileIds,
		priorityHandleOnlyHandles: snapshot.priorityHandleOnlyHandles,
		priorityOnly: true,
		limit: limit + 1,
	});
	return {
		list: snapshot.list,
		items: fetched.slice(0, limit),
		hasMore: fetched.length > limit,
	};
}
