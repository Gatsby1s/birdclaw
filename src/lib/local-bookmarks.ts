import { databaseWriteEffect } from "./database-writer";
import { runEffectPromise } from "./effect-runtime";
import type { Database } from "./sqlite";

export interface LocalBookmarkMutation {
	accountId: string;
	tweetId: string;
	bookmarked: boolean;
}

export type LocalBookmarkMutationResult =
	| {
			ok: true;
			accountId: string;
			tweetId: string;
			bookmarked: boolean;
	  }
	| {
			ok: false;
			reason: "account-not-found" | "tweet-not-found";
	  };

function writeLocalBookmark(
	db: Database,
	{ accountId, tweetId, bookmarked }: LocalBookmarkMutation,
): LocalBookmarkMutationResult {
	if (!db.prepare("select 1 from accounts where id = ?").get(accountId)) {
		return { ok: false, reason: "account-not-found" };
	}
	if (!db.prepare("select 1 from tweets where id = ?").get(tweetId)) {
		return { ok: false, reason: "tweet-not-found" };
	}

	const now = new Date().toISOString();
	db.prepare(
		`
    insert into local_tweet_bookmarks (
      account_id, tweet_id, is_bookmarked, created_at, updated_at
    ) values (?, ?, ?, ?, ?)
    on conflict(account_id, tweet_id) do update set
      is_bookmarked = excluded.is_bookmarked,
      updated_at = excluded.updated_at
    `,
	).run(accountId, tweetId, bookmarked ? 1 : 0, now, now);

	return { ok: true, accountId, tweetId, bookmarked };
}

export function setLocalBookmarkEffect(input: LocalBookmarkMutation) {
	return databaseWriteEffect((db) => writeLocalBookmark(db, input));
}

export function setLocalBookmark(input: LocalBookmarkMutation) {
	return runEffectPromise(setLocalBookmarkEffect(input));
}
