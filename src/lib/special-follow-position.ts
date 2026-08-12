import { getNativeDb, getReadDb } from "./db";
import { createProfilePrioritySnapshot } from "./profile-priority";
import type { Database } from "./sqlite";
import type {
	SpecialFollowPositionResponse,
	SpecialFollowPositionWriteRequest,
	SpecialFollowPositionWriteResponse,
	SpecialFollowReadPosition,
} from "./types";

export const SPECIAL_FOLLOW_VIEW_KEY = "special-follow" as const;
export const SPECIAL_FOLLOW_PIXEL_OFFSET_LIMIT = 4096;

interface ReadPositionRow {
	anchorTweetId: string;
	anchorCreatedAt: string;
	pixelOffset: number;
	clientSessionId: string;
	clientSequence: number;
	revision: number;
	updatedAt: string;
}

export class SpecialFollowPositionError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 404,
	) {
		super(message);
		this.name = "SpecialFollowPositionError";
	}
}

function readPosition(
	db: Database,
	accountId: string,
): SpecialFollowReadPosition | null {
	const row = db
		.prepare(
			`select
			   anchor_tweet_id as anchorTweetId,
			   anchor_created_at as anchorCreatedAt,
			   pixel_offset as pixelOffset,
			   client_session_id as clientSessionId,
			   client_sequence as clientSequence,
			   revision,
			   updated_at as updatedAt
			 from timeline_read_positions
			 where account_id = ? and view_key = ?`,
		)
		.get(accountId, SPECIAL_FOLLOW_VIEW_KEY) as ReadPositionRow | undefined;
	return row
		? {
				...row,
				pixelOffset: Number(row.pixelOffset),
				clientSequence: Number(row.clientSequence),
				revision: Number(row.revision),
			}
		: null;
}

export function specialFollowAccountExists(
	accountId: string,
	db: Database = getReadDb({ seedDemoData: false }),
) {
	return Boolean(
		db.prepare("select 1 from accounts where id = ?").get(accountId),
	);
}

export function getSpecialFollowPosition(
	accountId: string,
	db: Database = getReadDb({ seedDemoData: false }),
): SpecialFollowPositionResponse {
	if (!specialFollowAccountExists(accountId, db)) {
		throw new SpecialFollowPositionError("BirdClaw account not found.", 404);
	}
	return {
		accountId,
		viewKey: SPECIAL_FOLLOW_VIEW_KEY,
		position: readPosition(db, accountId),
	};
}

export function getValidSpecialFollowAnchor(
	accountId: string,
	tweetId: string,
	db: Database = getReadDb({ seedDemoData: false }),
) {
	const row = db
		.prepare(
			`select
			   t.id as tweetId,
			   t.created_at as createdAt,
			   p.id as authorProfileId,
			   p.handle as authorHandle
			 from tweet_account_edges e
			 join tweets t on t.id = e.tweet_id
			 join profiles p on p.id = t.author_profile_id
			 where e.account_id = ?
			   and e.kind = 'home'
			   and e.tweet_id = ?
			 limit 1`,
		)
		.get(accountId, tweetId) as
		| {
				tweetId: string;
				createdAt: string;
				authorProfileId: string;
				authorHandle: string;
		  }
		| undefined;
	if (!row) return null;
	const priorities = createProfilePrioritySnapshot(db);
	return priorities.isSpecialFollow({
		handle: row.authorHandle,
		identifier: row.authorProfileId,
	})
		? { tweetId: row.tweetId, createdAt: row.createdAt }
		: null;
}

export function saveSpecialFollowPosition(
	input: SpecialFollowPositionWriteRequest,
	db: Database = getNativeDb({ seedDemoData: false }),
	now = new Date(),
): SpecialFollowPositionWriteResponse {
	if (!specialFollowAccountExists(input.accountId, db)) {
		throw new SpecialFollowPositionError("BirdClaw account not found.", 404);
	}

	const existing = readPosition(db, input.accountId);
	if (
		existing?.clientSessionId === input.clientSessionId &&
		input.clientSequence <= existing.clientSequence
	) {
		return {
			ok: true,
			applied: false,
			accountId: input.accountId,
			viewKey: SPECIAL_FOLLOW_VIEW_KEY,
			position: existing,
		};
	}
	if (
		existing &&
		existing.clientSessionId !== input.clientSessionId &&
		input.expectedRevision !== existing.revision
	) {
		return {
			ok: false,
			applied: false,
			conflict: true,
			accountId: input.accountId,
			viewKey: SPECIAL_FOLLOW_VIEW_KEY,
			position: existing,
		};
	}
	if (!existing && input.expectedRevision !== 0) {
		return {
			ok: false,
			applied: false,
			conflict: true,
			accountId: input.accountId,
			viewKey: SPECIAL_FOLLOW_VIEW_KEY,
			position: null,
		};
	}

	const anchor = getValidSpecialFollowAnchor(
		input.accountId,
		input.anchorTweetId,
		db,
	);
	if (!anchor) {
		throw new SpecialFollowPositionError(
			"Reading anchor is not a current special-follow Home post.",
			400,
		);
	}

	const pixelOffset = Math.max(
		-SPECIAL_FOLLOW_PIXEL_OFFSET_LIMIT,
		Math.min(SPECIAL_FOLLOW_PIXEL_OFFSET_LIMIT, Math.round(input.pixelOffset)),
	);
	const updatedAt = now.toISOString();
	const result = db
		.prepare(
			`insert into timeline_read_positions (
			   account_id, view_key, anchor_tweet_id, anchor_created_at,
			   pixel_offset, client_session_id, client_sequence, updated_at,
			   revision
			 ) values (?, ?, ?, ?, ?, ?, ?, ?, 1)
			 on conflict(account_id, view_key) do update set
			   anchor_tweet_id = excluded.anchor_tweet_id,
			   anchor_created_at = excluded.anchor_created_at,
			   pixel_offset = excluded.pixel_offset,
			   client_session_id = excluded.client_session_id,
			   client_sequence = excluded.client_sequence,
			   revision = timeline_read_positions.revision + 1,
			   updated_at = excluded.updated_at
			 where excluded.client_session_id <> timeline_read_positions.client_session_id
			    or excluded.client_sequence > timeline_read_positions.client_sequence`,
		)
		.run(
			input.accountId,
			SPECIAL_FOLLOW_VIEW_KEY,
			anchor.tweetId,
			anchor.createdAt,
			pixelOffset,
			input.clientSessionId,
			input.clientSequence,
			updatedAt,
		);
	const position = readPosition(db, input.accountId);
	if (!position) throw new Error("Reading position was not persisted.");
	return {
		ok: true,
		applied: result.changes > 0,
		accountId: input.accountId,
		viewKey: SPECIAL_FOLLOW_VIEW_KEY,
		position,
	};
}
