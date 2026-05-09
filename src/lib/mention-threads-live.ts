import type { Database } from "./sqlite";
import { listThreadViaBird } from "./bird";
import { getNativeDb } from "./db";
import type { XurlMentionData, XurlMentionsResponse } from "./types";
import { ensureStubProfileForXUser, upsertProfileFromXUser } from "./x-profile";

const DEFAULT_LIMIT = 30;
const DEFAULT_DELAY_MS = 1500;
const DEFAULT_TIMEOUT_MS = 15_000;

function assertPositiveInteger(value: number, name: string) {
	if (!Number.isFinite(value) || value < 1) {
		throw new Error(`${name} must be at least 1`);
	}
	return Math.floor(value);
}

function parseNonNegativeInteger(value: number | undefined, name: string) {
	if (value === undefined) {
		return undefined;
	}
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(`${name} must be non-negative`);
	}
	return Math.floor(value);
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getMediaCount(tweet: XurlMentionData) {
	const urls = Array.isArray(tweet.entities?.urls) ? tweet.entities.urls : [];
	return urls.filter(
		(url) =>
			url &&
			typeof url === "object" &&
			typeof (url as Record<string, unknown>).media_key === "string",
	).length;
}

function replaceTweetFts(db: Database, tweetId: string, text: string) {
	db.prepare("delete from tweets_fts where tweet_id = ?").run(tweetId);
	db.prepare("insert into tweets_fts (tweet_id, text) values (?, ?)").run(
		tweetId,
		text,
	);
}

function resolveAccount(db: Database, accountId?: string) {
	const row = accountId
		? (db
				.prepare("select id, handle from accounts where id = ?")
				.get(accountId) as { id: string; handle: string } | undefined)
		: (db
				.prepare(
					`
          select id, handle
          from accounts
          order by is_default desc, created_at asc
          limit 1
          `,
				)
				.get() as { id: string; handle: string } | undefined);

	if (!row) {
		throw new Error(`Unknown account: ${accountId ?? "default"}`);
	}

	return {
		accountId: row.id,
		handle: row.handle.replace(/^@/, "").toLowerCase(),
	};
}

function listRecentMentionIds(db: Database, accountId: string, limit: number) {
	return (
		db
			.prepare(
				`
        select id
        from tweets
        where kind = 'mention' and account_id = ?
        order by created_at desc
        limit ?
        `,
			)
			.all(accountId, limit) as Array<{ id: string }>
	).map((row) => row.id);
}

function getReplyToId(tweet: XurlMentionData) {
	return tweet.referenced_tweets?.find((entry) => entry.type === "replied_to")
		?.id;
}

function mergeMentionThreadIntoLocalStore({
	db,
	accountId,
	accountHandle,
	mentionIds,
	payload,
}: {
	db: Database;
	accountId: string;
	accountHandle: string;
	mentionIds: Set<string>;
	payload: XurlMentionsResponse;
}) {
	const usersById = new Map(
		(payload.includes?.users ?? []).map((user) => [user.id, user]),
	);
	const upsertTweet = db.prepare(
		`
    insert into tweets (
      id, account_id, author_profile_id, kind, text, created_at,
      is_replied, reply_to_id, like_count, media_count, bookmarked, liked,
      entities_json, media_json, quoted_tweet_id
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, '[]', null)
    on conflict(id) do update set
      account_id = excluded.account_id,
      author_profile_id = excluded.author_profile_id,
      kind = case
        when tweets.kind in ('home', 'mention') then tweets.kind
        when excluded.kind in ('home', 'mention') then excluded.kind
        else coalesce(nullif(tweets.kind, ''), excluded.kind)
      end,
      text = excluded.text,
      created_at = excluded.created_at,
      is_replied = max(tweets.is_replied, excluded.is_replied),
      reply_to_id = coalesce(excluded.reply_to_id, tweets.reply_to_id),
      like_count = excluded.like_count,
      media_count = excluded.media_count,
      entities_json = excluded.entities_json,
      media_json = excluded.media_json,
      bookmarked = tweets.bookmarked,
      liked = tweets.liked
    `,
	);

	db.transaction(() => {
		for (const tweet of payload.data) {
			const author =
				usersById.get(tweet.author_id) ??
				({
					id: tweet.author_id,
					username: `user_${tweet.author_id}`,
					name: `user_${tweet.author_id}`,
				} as const);
			const profile = usersById.has(tweet.author_id)
				? upsertProfileFromXUser(db, author)
				: ensureStubProfileForXUser(db, tweet.author_id);
			const handle = author.username.toLowerCase();
			const kind = mentionIds.has(tweet.id)
				? "mention"
				: handle === accountHandle
					? "home"
					: "thread";
			const replyToId = getReplyToId(tweet);
			upsertTweet.run(
				tweet.id,
				accountId,
				profile.profile.id,
				kind,
				tweet.text,
				tweet.created_at,
				replyToId ? 1 : 0,
				replyToId ?? null,
				Number(tweet.public_metrics?.like_count ?? 0),
				getMediaCount(tweet),
				JSON.stringify(tweet.entities ?? {}),
			);
			replaceTweetFts(db, tweet.id, tweet.text);
		}
	})();
}

export async function syncMentionThreads({
	account,
	limit = DEFAULT_LIMIT,
	delayMs = DEFAULT_DELAY_MS,
	timeoutMs = DEFAULT_TIMEOUT_MS,
	all = false,
	maxPages,
}: {
	account?: string;
	limit?: number;
	delayMs?: number;
	timeoutMs?: number;
	all?: boolean;
	maxPages?: number;
}) {
	const parsedLimit = assertPositiveInteger(limit, "--limit");
	const parsedDelayMs = parseNonNegativeInteger(delayMs, "--delay-ms") ?? 0;
	const parsedTimeoutMs = assertPositiveInteger(timeoutMs, "--timeout-ms");
	const parsedMaxPages = parseNonNegativeInteger(maxPages, "--max-pages");
	const db = getNativeDb();
	const resolvedAccount = resolveAccount(db, account);
	const mentionIds = listRecentMentionIds(
		db,
		resolvedAccount.accountId,
		parsedLimit,
	);
	const mentionIdSet = new Set(mentionIds);
	const results: Array<{
		tweetId: string;
		ok: boolean;
		count: number;
		error?: string;
	}> = [];
	let mergedTweets = 0;
	const uniqueTweetIds = new Set<string>();

	for (const [index, tweetId] of mentionIds.entries()) {
		if (index > 0 && parsedDelayMs > 0) {
			await sleep(parsedDelayMs);
		}
		try {
			const payload = await listThreadViaBird({
				tweetId,
				all,
				maxPages: parsedMaxPages,
				timeoutMs: parsedTimeoutMs,
			});
			mergeMentionThreadIntoLocalStore({
				db,
				accountId: resolvedAccount.accountId,
				accountHandle: resolvedAccount.handle,
				mentionIds: mentionIdSet,
				payload,
			});
			for (const tweet of payload.data) {
				uniqueTweetIds.add(tweet.id);
			}
			mergedTweets += payload.data.length;
			results.push({ tweetId, ok: true, count: payload.data.length });
		} catch (error) {
			results.push({
				tweetId,
				ok: false,
				count: 0,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	const failures = results.filter((item) => !item.ok);
	return {
		ok: true,
		accountId: resolvedAccount.accountId,
		mentions: mentionIds.length,
		threads: results.length,
		succeeded: results.length - failures.length,
		failed: failures.length,
		mergedTweets,
		uniqueTweets: uniqueTweetIds.size,
		options: {
			limit: parsedLimit,
			delayMs: parsedDelayMs,
			timeoutMs: parsedTimeoutMs,
			all,
			maxPages: parsedMaxPages ?? null,
		},
		results,
		failures,
	};
}
