import { Effect } from "effect";
import { lookupProfilesViaBirdEffect } from "./bird";
import { databaseWriteEffect } from "./database-writer";
import { parseManualRetweet } from "./manual-retweet";
import { profileHandleKey } from "./profile-row";
import type { Database } from "./sqlite";
import type { XurlMentionUser, XurlMentionsResponse } from "./types";
import { upsertProfileFromXUser } from "./x-profile";

const MAX_HISTORICAL_MANUAL_RETWEETS = 200;
const MAX_PROFILE_LOOKUPS_PER_SYNC = 50;

export interface ManualRetweetProfileHydrationResult {
	candidates: number;
	requested: number;
	hydrated: number;
}

export function manualRetweetProfileHandles(payload: XurlMentionsResponse) {
	const handles = new Map<string, string>();
	for (const tweet of [...payload.data, ...(payload.includes?.tweets ?? [])]) {
		const parsed = parseManualRetweet(tweet.text);
		if (!parsed) {
			continue;
		}
		const key = profileHandleKey(parsed.handle);
		if (key) {
			handles.set(key, parsed.handle);
		}
	}
	return [...handles.values()];
}

function recentManualRetweetProfileHandles(db: Database, accountId: string) {
	const rows = db
		.prepare(
			`
      select tweet.text
      from tweets tweet
      where tweet.text like 'RT @%:%'
        and exists (
          select 1
          from tweet_account_edges edge
          where edge.tweet_id = tweet.id
            and edge.account_id = ?
            and edge.kind = 'home'
        )
      order by tweet.created_at desc
      limit ?
      `,
		)
		.all(accountId, MAX_HISTORICAL_MANUAL_RETWEETS) as Array<{ text: string }>;
	return rows.flatMap((row) => {
		const parsed = parseManualRetweet(row.text);
		return parsed ? [parsed.handle] : [];
	});
}

function hydratedPayloadUsers(payload: XurlMentionsResponse) {
	const users = new Map<string, XurlMentionUser>();
	for (const user of payload.includes?.users ?? []) {
		const key = profileHandleKey(user.username);
		if (key && user.profile_image_url?.trim()) {
			users.set(key, user);
		}
	}
	return users;
}

export function hydrateManualRetweetProfilesEffect(
	db: Database,
	payload: XurlMentionsResponse,
	accountId: string,
): Effect.Effect<ManualRetweetProfileHydrationResult, unknown> {
	return Effect.gen(function* () {
		const handlesByKey = new Map<string, string>();
		for (const handle of [
			...manualRetweetProfileHandles(payload),
			...recentManualRetweetProfileHandles(db, accountId),
		]) {
			const key = profileHandleKey(handle);
			if (key && !handlesByKey.has(key)) {
				handlesByKey.set(key, handle);
			}
		}
		const handles = [...handlesByKey.values()];
		const findHydratedProfile = db.prepare(`
	      select 1 as found
      from profiles
      where lower(handle) = lower(?)
        and nullif(trim(avatar_url), '') is not null
	      limit 1
	    `);
		const missingHandles = handles.filter(
			(handle) => !findHydratedProfile.get(handle),
		);
		if (missingHandles.length === 0) {
			return { candidates: handles.length, requested: 0, hydrated: 0 };
		}

		const payloadUsers = hydratedPayloadUsers(payload);
		const inlineUsers: XurlMentionUser[] = [];
		const targets: string[] = [];
		for (const handle of missingHandles) {
			const payloadUser = payloadUsers.get(profileHandleKey(handle));
			if (payloadUser) {
				inlineUsers.push(payloadUser);
			} else if (targets.length < MAX_PROFILE_LOOKUPS_PER_SYNC) {
				targets.push(handle);
			}
		}

		const results =
			targets.length > 0 ? yield* lookupProfilesViaBirdEffect(targets) : [];
		const users = [
			...inlineUsers,
			...results.flatMap((result) => (result.user ? [result.user] : [])),
		];
		const hydrated =
			users.length > 0
				? yield* databaseWriteEffect((writeDb) => {
						let count = 0;
						for (const user of users) {
							const resolved = upsertProfileFromXUser(writeDb, user);
							if (resolved.profile.avatarUrl) {
								count += 1;
							}
						}
						return count;
					}, db)
				: 0;

		return {
			candidates: handles.length,
			requested: targets.length,
			hydrated,
		};
	});
}
