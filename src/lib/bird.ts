import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { getBirdCommand } from "./config";
import { runEffectPromise } from "./effect-runtime";
import type {
	XurlMentionData,
	XurlFollowUsersResponse,
	XurlMediaItem,
	XurlMentionsResponse,
	XurlMentionUser,
	XurlReferencedTweet,
	XurlTweetData,
	XurlTweetsResponse,
} from "./types";

const execFileAsync = promisify(execFile);
const BIRD_JSON_MAX_BUFFER_BYTES = 512 * 1024 * 1024;
const BIRD_EXPAND_TIMEOUT_MS = 30_000;
const BIRD_STDOUT_REDIRECT_SCRIPT = 'out="$1"; shift; exec "$@" > "$out"';

interface BirdTweetMedia {
	type?: string;
	url?: string;
	previewUrl?: string;
	videoUrl?: string;
	width?: number;
	height?: number;
	durationMs?: number;
	altText?: string;
}

interface BirdTweetAuthor {
	username?: string;
	name?: string;
	profileImageUrl?: string;
	profile_image_url?: string;
}

interface BirdTweetArticle {
	title?: string;
	previewText?: string;
	coverImageUrl?: string;
}

type BirdReferencedTweetItem = Partial<BirdTweetItem> & { id?: string | null };

interface BirdTweetItem {
	id: string;
	text: string;
	createdAt: string;
	replyCount?: number;
	retweetCount?: number;
	likeCount?: number;
	conversationId?: string;
	inReplyToStatusId?: string | null;
	quotedStatusId?: string | null;
	retweetedStatusId?: string | null;
	quotedTweet?: BirdReferencedTweetItem | null;
	retweetedTweet?: BirdReferencedTweetItem | null;
	author?: BirdTweetAuthor;
	authorId?: string;
	media?: BirdTweetMedia[];
	article?: BirdTweetArticle | null;
	_raw?: unknown;
}

export interface ExpandedRetweetedText {
	tweetId: string;
	sourceTweetId: string;
	text: string;
}

export interface BirdDmUser {
	id: string;
	username?: string;
	name?: string;
	profileImageUrl?: string;
}

export interface BirdDmEvent {
	id: string;
	conversationId?: string;
	text: string;
	createdAt?: string;
	senderId?: string;
	recipientId?: string;
	sender?: BirdDmUser;
	recipient?: BirdDmUser;
	inboxKind?: "accepted" | "request";
	isMessageRequest?: boolean;
}

export interface BirdDmConversation {
	id: string;
	participants: BirdDmUser[];
	messages: BirdDmEvent[];
	lastMessageAt?: string;
	lastMessagePreview?: string;
	inboxKind?: "accepted" | "request";
	isMessageRequest?: boolean;
}

export interface BirdDmsResponse {
	success: true;
	conversations: BirdDmConversation[];
	events: BirdDmEvent[];
}

export interface BirdAuthenticatedAccount {
	id?: string;
	username: string;
}

export type BirdDmRequestAction = "accept" | "reject" | "block";

export type BirdDmMutationResponse =
	| {
			success: true;
			conversationId?: string;
			userId?: string;
			username?: string;
			blockedUserId?: string;
			blockedUsername?: string;
	  }
	| {
			success: false;
			error: string;
	  };

interface BirdUserOverviewPayload {
	user?: {
		id?: string;
		username?: string;
		name?: string;
		description?: string;
		location?: string;
		url?: string;
		verified?: boolean;
		verifiedType?: string;
		verified_type?: string;
		followersCount?: number;
		followingCount?: number;
		profileImageUrl?: string;
		createdAt?: string;
		entities?: Record<string, unknown>;
		affiliation?: Record<string, unknown>;
	};
}

interface BirdProfilesPayload {
	users?: NonNullable<BirdUserOverviewPayload["user"]>[];
	errors?: Array<{ target?: string; error?: string }>;
}

type BirdFollowUsersPayload =
	| NonNullable<BirdUserOverviewPayload["user"]>[]
	| {
			users?: NonNullable<BirdUserOverviewPayload["user"]>[];
			nextCursor?: string | null;
	  };

function toIsoTimestamp(value: string) {
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		return value;
	}
	return parsed.toISOString();
}

function escapeJsonStringControlChars(value: string) {
	let output = "";
	let inString = false;
	let escaped = false;

	for (const character of value) {
		if (!inString) {
			output += character;
			if (character === '"') {
				inString = true;
			}
			continue;
		}

		if (escaped) {
			output += character;
			escaped = false;
			continue;
		}

		if (character === "\\") {
			output += character;
			escaped = true;
			continue;
		}

		if (character === '"') {
			output += character;
			inString = false;
			continue;
		}

		if (character === "\n") {
			output += "\\n";
			continue;
		}
		if (character === "\r") {
			output += "\\r";
			continue;
		}
		if (character === "\t") {
			output += "\\t";
			continue;
		}
		if (character.charCodeAt(0) < 0x20) {
			output += `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
			continue;
		}

		output += character;
	}

	return output;
}

function parseBirdJson(stdout: string) {
	try {
		return JSON.parse(stdout) as unknown;
	} catch (error) {
		if (!(error instanceof SyntaxError)) {
			throw error;
		}
		return JSON.parse(escapeJsonStringControlChars(stdout)) as unknown;
	}
}

function formatBirdCommandError(error: unknown, birdCommand: string) {
	const text = [
		error instanceof Error ? error.message : "",
		error &&
		typeof error === "object" &&
		"stderr" in error &&
		typeof error.stderr === "string"
			? error.stderr
			: "",
		error &&
		typeof error === "object" &&
		"stdout" in error &&
		typeof error.stdout === "string"
			? error.stdout
			: "",
	].join("\n");
	if (
		(error instanceof Error &&
			"code" in error &&
			(error as { code?: unknown }).code === "ENOENT") ||
		(/No such file or directory|command not found|cannot execute/i.test(text) &&
			text.includes(birdCommand))
	) {
		return new Error(
			`bird command unavailable: ${birdCommand}\nInstall bird on PATH, set BIRDCLAW_BIRD_COMMAND, or update ~/.birdclaw/config.json mentions.birdCommand.`,
		);
	}

	return error;
}

function isUnsupportedBirdOptionError(error: unknown, option: string) {
	if (!error || typeof error !== "object") {
		return false;
	}
	const text = [
		error instanceof Error ? error.message : "",
		"stderr" in error && typeof error.stderr === "string" ? error.stderr : "",
		"stdout" in error && typeof error.stdout === "string" ? error.stdout : "",
	].join("\n");
	return text.includes(option) && /unknown option|error:/i.test(text);
}

function isUnsupportedBirdCommandError(error: unknown, command: string) {
	if (!error || typeof error !== "object") {
		return false;
	}
	const text = [
		error instanceof Error ? error.message : "",
		"stderr" in error && typeof error.stderr === "string" ? error.stderr : "",
		"stdout" in error && typeof error.stdout === "string" ? error.stdout : "",
	].join("\n");
	return text.includes(command) && /unknown command|error:/i.test(text);
}

function makeBirdStdoutTempEffect() {
	return Effect.acquireRelease(
		Effect.sync(() => {
			const tempDir = mkdtempSync(join(tmpdir(), "birdclaw-bird-"));
			return { tempDir, stdoutPath: join(tempDir, "stdout.json") };
		}),
		({ tempDir }) =>
			Effect.sync(() => rmSync(tempDir, { recursive: true, force: true })),
	);
}

export function runBirdJsonCommandEffect(args: string[], timeoutMs?: number) {
	return Effect.scoped(
		Effect.gen(function* () {
			const birdCommand = yield* Effect.try({
				try: () => getBirdCommand(),
				catch: (error) =>
					error instanceof Error ? error : new Error(String(error)),
			});
			const { stdoutPath } = yield* makeBirdStdoutTempEffect();
			yield* Effect.tryPromise({
				try: () =>
					execFileAsync(
						"/bin/bash",
						[
							"-c",
							BIRD_STDOUT_REDIRECT_SCRIPT,
							"birdclaw-bird",
							stdoutPath,
							birdCommand,
							...args,
						],
						{ maxBuffer: BIRD_JSON_MAX_BUFFER_BYTES, timeout: timeoutMs },
					),
				catch: (error) => formatBirdCommandError(error, birdCommand),
			});
			return yield* Effect.try({
				try: () => readFileSync(stdoutPath, "utf8"),
				catch: (error) => error,
			});
		}),
	);
}

function runBirdJsonCommandAllowFailureEffect(
	args: string[],
	timeoutMs?: number,
) {
	return Effect.scoped(
		Effect.gen(function* () {
			const birdCommand = yield* Effect.try({
				try: () => getBirdCommand(),
				catch: (error) =>
					error instanceof Error ? error : new Error(String(error)),
			});
			const { stdoutPath } = yield* makeBirdStdoutTempEffect();
			yield* Effect.tryPromise({
				try: () =>
					execFileAsync(
						"/bin/bash",
						[
							"-c",
							BIRD_STDOUT_REDIRECT_SCRIPT,
							"birdclaw-bird",
							stdoutPath,
							birdCommand,
							...args,
						],
						{ maxBuffer: BIRD_JSON_MAX_BUFFER_BYTES, timeout: timeoutMs },
					).catch((error: unknown) => {
						const stdout = readFileSync(stdoutPath, "utf8");
						if (stdout.trim().length > 0) {
							return { stdout: "", stderr: "" };
						}
						throw formatBirdCommandError(error, birdCommand);
					}),
				catch: (error) => error,
			});
			return yield* Effect.try({
				try: () => readFileSync(stdoutPath, "utf8"),
				catch: (error) => error,
			});
		}),
	);
}

function getBirdTweetItems(payload: unknown, command: string) {
	if (Array.isArray(payload)) {
		return payload as BirdTweetItem[];
	}

	if (
		payload &&
		typeof payload === "object" &&
		Array.isArray((payload as { tweets?: unknown }).tweets)
	) {
		return (payload as { tweets: BirdTweetItem[] }).tweets;
	}

	throw new Error(`bird ${command} returned unexpected JSON`);
}

function getBirdTweetItem(payload: unknown, command: string) {
	if (payload && typeof payload === "object") {
		const record = payload as { id?: unknown };
		if (typeof record.id === "string" && record.id.length > 0) {
			return payload as BirdTweetItem;
		}
	}

	throw new Error(`bird ${command} returned unexpected JSON`);
}

function validBirdMedia(media: BirdTweetMedia[] | undefined) {
	return Array.isArray(media)
		? media.filter(
				(item) => typeof item?.url === "string" && item.url.trim().length > 0,
			)
		: [];
}

function birdMediaKey(tweetId: string, index: number) {
	return `bird_media_${tweetId}_${String(index)}`;
}

function toMediaEntities(item: Pick<BirdTweetItem, "id" | "media">) {
	const media = validBirdMedia(item.media);
	if (media.length === 0) {
		return undefined;
	}

	return {
		urls: media.map((mediaItem, index) => ({
			start: index,
			end: index,
			url: mediaItem.url as string,
			expanded_url: mediaItem.url as string,
			display_url: mediaItem.url as string,
			media_key: birdMediaKey(item.id, index),
		})),
	};
}

function toMediaAttachments(item: Pick<BirdTweetItem, "id" | "media">) {
	const media = validBirdMedia(item.media);
	return media.length > 0
		? { media_keys: media.map((_, index) => birdMediaKey(item.id, index)) }
		: undefined;
}

function toXurlMediaItems(item: Pick<BirdTweetItem, "id" | "media">) {
	return validBirdMedia(item.media).map((media, index) => {
		const type =
			media.type === "photo" || media.type === "image"
				? "photo"
				: media.type === "gif" || media.type === "animated_gif"
					? "animated_gif"
					: media.type === "video"
						? "video"
						: (media.type ?? (media.videoUrl ? "video" : "photo"));
		const previewUrl =
			type === "photo" ? undefined : (media.url ?? media.previewUrl);
		const imageUrl = type === "photo" ? media.url : undefined;
		const videoUrl =
			type === "video" || type === "animated_gif" ? media.videoUrl : undefined;

		return {
			media_key: birdMediaKey(item.id, index),
			type,
			...(imageUrl ? { url: imageUrl } : {}),
			...(previewUrl ? { preview_image_url: previewUrl } : {}),
			...(typeof media.width === "number" && Number.isFinite(media.width)
				? { width: media.width }
				: {}),
			...(typeof media.height === "number" && Number.isFinite(media.height)
				? { height: media.height }
				: {}),
			...(typeof media.durationMs === "number" &&
			Number.isFinite(media.durationMs)
				? { duration_ms: media.durationMs }
				: {}),
			...(media.altText ? { alt_text: media.altText } : {}),
			...(videoUrl
				? {
						variants: [
							{
								url: videoUrl,
								content_type: "video/mp4",
							},
						],
					}
				: {}),
		} satisfies XurlMediaItem;
	});
}

function toTweetEntities(item: BirdTweetItem) {
	const mediaEntities = toMediaEntities(item);
	const title = item.article?.title?.trim();
	if (!title) return mediaEntities;
	const handle = item.author?.username?.replace(/^@/, "");
	const url = handle
		? `https://x.com/${handle}/status/${item.id}`
		: `https://x.com/i/status/${item.id}`;
	return {
		...mediaEntities,
		article: {
			title,
			url,
			...(item.article?.previewText?.trim()
				? { previewText: item.article.previewText.trim() }
				: {}),
			...(item.article?.coverImageUrl?.trim()
				? { coverImageUrl: item.article.coverImageUrl.trim() }
				: {}),
		},
	};
}

function toReferencedTweets(item: BirdTweetItem) {
	const references: XurlReferencedTweet[] = [];
	if (typeof item.inReplyToStatusId === "string" && item.inReplyToStatusId) {
		references.push({ type: "replied_to", id: item.inReplyToStatusId });
	}

	const quotedTweetId =
		typeof item.quotedStatusId === "string" && item.quotedStatusId
			? item.quotedStatusId
			: typeof item.quotedTweet?.id === "string" && item.quotedTweet.id
				? item.quotedTweet.id
				: null;
	if (quotedTweetId) {
		references.push({ type: "quoted", id: quotedTweetId });
	}

	const retweetedTweetId =
		typeof item.retweetedStatusId === "string" && item.retweetedStatusId
			? item.retweetedStatusId
			: typeof item.retweetedTweet?.id === "string" && item.retweetedTweet.id
				? item.retweetedTweet.id
				: null;
	if (retweetedTweetId) {
		references.push({ type: "retweeted", id: retweetedTweetId });
	}

	return references.length > 0 ? references : undefined;
}

function toTweetData(item: BirdTweetItem): XurlTweetData {
	const authorId = birdTweetAuthorId(item);
	return {
		id: item.id,
		author_id: authorId,
		text: item.text,
		created_at: toIsoTimestamp(item.createdAt),
		conversation_id: item.conversationId ?? item.id,
		attachments: toMediaAttachments(item),
		entities: toTweetEntities(item),
		referenced_tweets: toReferencedTweets(item),
		public_metrics: {
			reply_count: Number(item.replyCount ?? 0),
			retweet_count: Number(item.retweetCount ?? 0),
			like_count: Number(item.likeCount ?? 0),
		},
		edit_history_tweet_ids: [item.id],
	};
}

function asRecord(value: unknown) {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: undefined;
}

function nonEmptyStringField(
	record: Record<string, unknown> | undefined,
	key: string,
) {
	const value = record?.[key];
	return typeof value === "string" && value.trim().length > 0
		? value
		: undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string) {
	const value = record?.[key];
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string) {
	const value = record?.[key];
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function booleanField(
	record: Record<string, unknown> | undefined,
	key: string,
) {
	const value = record?.[key];
	return typeof value === "boolean" ? value : undefined;
}

function rawUserFromBirdTweet(item: BirdTweetItem) {
	const raw = asRecord(item._raw);
	const rawCore = asRecord(raw?.core);
	const userResults = asRecord(rawCore?.user_results);
	return asRecord(userResults?.result);
}

function xUserFromBirdRawUser(rawUser: Record<string, unknown> | undefined) {
	const id = stringField(rawUser, "rest_id");
	const core = asRecord(rawUser?.core);
	const legacy = asRecord(rawUser?.legacy);
	const avatar = asRecord(rawUser?.avatar);
	const location = asRecord(rawUser?.location);
	const profileBio = asRecord(rawUser?.profile_bio);
	const verification = asRecord(rawUser?.verification);
	const username =
		stringField(core, "screen_name") ?? stringField(legacy, "screen_name");
	if (!id || !username) {
		return null;
	}

	const followersCount =
		numberField(legacy, "followers_count") ??
		numberField(legacy, "normal_followers_count");
	const followingCount = numberField(legacy, "friends_count");
	return {
		id,
		username,
		name: stringField(core, "name") ?? stringField(legacy, "name") ?? username,
		description:
			stringField(profileBio, "description") ??
			stringField(legacy, "description"),
		location:
			stringField(location, "location") ?? stringField(legacy, "location"),
		url: stringField(legacy, "url"),
		verified: booleanField(verification, "verified"),
		profile_image_url:
			stringField(avatar, "image_url") ??
			stringField(legacy, "profile_image_url_https") ??
			stringField(legacy, "profile_image_url"),
		created_at: stringField(core, "created_at"),
		entities: asRecord(legacy?.entities),
		public_metrics: {
			followers_count: followersCount ?? 0,
			following_count: followingCount ?? 0,
		},
	} satisfies XurlMentionUser;
}

function xUserFromBirdTweet(item: BirdTweetItem) {
	return xUserFromBirdRawUser(rawUserFromBirdTweet(item));
}

function birdTweetAuthorId(item: BirdTweetItem) {
	return String(
		xUserFromBirdTweet(item)?.id ??
			item.authorId ??
			item.author?.username ??
			"unknown",
	);
}

function addBirdUser(users: Map<string, XurlMentionUser>, item: BirdTweetItem) {
	const rawUser = xUserFromBirdTweet(item);
	const authorId = String(
		rawUser?.id ?? item.authorId ?? item.author?.username ?? "unknown",
	);
	if (users.has(authorId)) {
		return;
	}
	if (rawUser) {
		users.set(authorId, rawUser);
		return;
	}
	const profileImageUrl =
		typeof item.author?.profileImageUrl === "string"
			? item.author.profileImageUrl
			: typeof item.author?.profile_image_url === "string"
				? item.author.profile_image_url
				: undefined;
	users.set(authorId, {
		id: authorId,
		username: item.author?.username ?? `user_${authorId}`,
		name: item.author?.name ?? item.author?.username ?? `user_${authorId}`,
		...(profileImageUrl ? { profile_image_url: profileImageUrl } : {}),
	});
}

function isFullBirdTweetItem(
	item: BirdReferencedTweetItem | null | undefined,
): item is BirdTweetItem {
	return (
		typeof item?.id === "string" &&
		typeof item.text === "string" &&
		typeof item.createdAt === "string"
	);
}

function normalizeBirdTweets(items: BirdTweetItem[]): XurlMentionsResponse {
	const users = new Map<string, XurlMentionUser>();
	const includedTweets = new Map<string, XurlTweetData>();
	const includedMedia = new Map<string, XurlMediaItem>();
	const addMedia = (item: BirdTweetItem) => {
		for (const media of toXurlMediaItems(item)) {
			includedMedia.set(media.media_key, media);
		}
	};
	const data = items.map((item): XurlMentionData => {
		addBirdUser(users, item);
		addMedia(item);
		for (const included of [item.quotedTweet, item.retweetedTweet]) {
			if (!isFullBirdTweetItem(included)) {
				continue;
			}
			addBirdUser(users, included);
			addMedia(included);
			includedTweets.set(included.id, toTweetData(included));
		}
		return toTweetData(item);
	});

	return {
		data,
		includes:
			users.size > 0 || includedTweets.size > 0 || includedMedia.size > 0
				? {
						...(users.size > 0 ? { users: Array.from(users.values()) } : {}),
						...(includedTweets.size > 0
							? { tweets: Array.from(includedTweets.values()) }
							: {}),
						...(includedMedia.size > 0
							? { media: Array.from(includedMedia.values()) }
							: {}),
					}
				: undefined,
		meta: {
			result_count: data.length,
			page_count: 1,
			next_token: null,
			...(data[0] ? { newest_id: data[0].id } : {}),
			...(data.at(-1) ? { oldest_id: data.at(-1)?.id } : {}),
		},
	};
}

function parseBirdJsonEffect(stdout: string) {
	return Effect.try({
		try: () => parseBirdJson(stdout),
		catch: (error) => error,
	});
}

function normalizeBirdTweetsPayloadEffect(payload: unknown, command: string) {
	return Effect.try({
		try: () => normalizeBirdTweets(getBirdTweetItems(payload, command)),
		catch: (error) => error,
	});
}

function birdProfileLookupTargets(payload: XurlMentionsResponse) {
	const targets = new Set<string>();
	for (const user of payload.includes?.users ?? []) {
		if (user.profile_image_url) {
			continue;
		}
		const username = user.username?.trim().replace(/^@/, "");
		if (username && username !== "unknown") {
			targets.add(username);
			continue;
		}
		const id = user.id?.trim();
		if (id && id !== "unknown") {
			targets.add(id);
		}
	}
	return [...targets];
}

function hydrateBirdTimelineProfilesEffect(payload: XurlMentionsResponse) {
	const users = payload.includes?.users ?? [];
	if (users.length === 0) {
		return Effect.succeed(payload);
	}

	const targets = birdProfileLookupTargets(payload);
	if (targets.length === 0) {
		return Effect.succeed(payload);
	}

	return lookupProfilesViaBirdEffect(targets).pipe(
		Effect.map((results) => {
			const hydratedById = new Map<string, XurlMentionUser>();
			const hydratedByHandle = new Map<string, XurlMentionUser>();
			for (const result of results) {
				if (!result.user) {
					continue;
				}
				hydratedById.set(result.user.id, result.user);
				hydratedByHandle.set(result.user.username.toLowerCase(), result.user);
			}

			const authorIdReplacements = new Map<string, string>();
			const nextUsers = users.map((user) => {
				const hydrated =
					hydratedById.get(user.id) ??
					hydratedByHandle.get(user.username.toLowerCase());
				if (!hydrated) {
					return user;
				}
				if (hydrated.id !== user.id) {
					authorIdReplacements.set(user.id, hydrated.id);
				}
				return { ...user, ...hydrated };
			});

			const rewriteTweetAuthor = <T extends XurlMentionData | XurlTweetData>(
				tweet: T,
			): T => {
				const authorId = authorIdReplacements.get(tweet.author_id);
				if (!authorId) {
					return tweet;
				}
				return { ...tweet, author_id: authorId };
			};

			return {
				...payload,
				data: payload.data.map(rewriteTweetAuthor),
				includes: {
					...payload.includes,
					users: nextUsers,
					...(payload.includes?.tweets
						? { tweets: payload.includes.tweets.map(rewriteTweetAuthor) }
						: {}),
				},
			};
		}),
		Effect.catchAll(() => Effect.succeed(payload)),
	);
}

function normalizeBirdTweetItemEffect(payload: unknown, command: string) {
	return Effect.try({
		try: () => getBirdTweetItem(payload, command),
		catch: (error) => error,
	});
}

function unwrapBirdTweetResult(
	value: unknown,
	depth = 0,
): Record<string, unknown> | undefined {
	if (depth > 8) return undefined;
	const record = asRecord(value);
	if (!record) return undefined;

	if (
		asRecord(record.note_tweet) ||
		asRecord(record.legacy) ||
		nonEmptyStringField(record, "rest_id")
	) {
		return record;
	}

	const tweetResults = asRecord(record.tweet_results);
	for (const nested of [record.tweet, record.result, tweetResults?.result]) {
		const tweet = unwrapBirdTweetResult(nested, depth + 1);
		if (tweet) return tweet;
	}
	return undefined;
}

function rawRetweetedTweetFromBirdItem(item: BirdTweetItem) {
	const raw = asRecord(item._raw);
	const legacy = asRecord(raw?.legacy);
	const retweetedStatusResult = asRecord(legacy?.retweeted_status_result);
	return unwrapBirdTweetResult(retweetedStatusResult?.result);
}

function likelyTruncatedBirdText(value: string) {
	const trimmed = value.trimEnd();
	return trimmed.endsWith("…") || trimmed.endsWith("...");
}

function expandedRetweetedTextFromBirdItem(
	item: BirdTweetItem,
	tweetId: string,
): ExpandedRetweetedText {
	const rawRetweetedTweet = rawRetweetedTweetFromBirdItem(item);
	const rawLegacy = asRecord(rawRetweetedTweet?.legacy);
	const noteTweet = asRecord(rawRetweetedTweet?.note_tweet);
	const noteTweetResults = asRecord(noteTweet?.note_tweet_results);
	const noteTweetResult = asRecord(noteTweetResults?.result);
	const normalizedRetweetedTweet = asRecord(item.retweetedTweet);
	const sourceTweetId =
		nonEmptyStringField(rawRetweetedTweet, "rest_id") ??
		nonEmptyStringField(rawLegacy, "id_str") ??
		nonEmptyStringField(normalizedRetweetedTweet, "id");
	const noteText = nonEmptyStringField(noteTweetResult, "text");
	const legacyText = nonEmptyStringField(rawLegacy, "full_text");
	const normalizedText = nonEmptyStringField(normalizedRetweetedTweet, "text");
	const rawLegacyIsComplete = booleanField(rawLegacy, "truncated") === false;
	const text =
		noteText ??
		(legacyText && (rawLegacyIsComplete || !likelyTruncatedBirdText(legacyText))
			? legacyText
			: undefined) ??
		(normalizedText && !likelyTruncatedBirdText(normalizedText)
			? normalizedText
			: undefined);

	if (!sourceTweetId || sourceTweetId === tweetId || !text) {
		throw new Error(
			`bird read ${tweetId} did not return expanded repost content`,
		);
	}

	return { tweetId, sourceTweetId, text };
}

export function listMentionsViaBirdEffect({
	maxResults,
}: {
	maxResults: number;
}): Effect.Effect<XurlMentionsResponse, unknown> {
	return Effect.gen(function* () {
		const stdout = yield* runBirdJsonCommandEffect([
			"mentions",
			"-n",
			String(maxResults),
			"--json",
		]);
		const payload = yield* parseBirdJsonEffect(stdout);
		return yield* normalizeBirdTweetsPayloadEffect(payload, "mentions");
	});
}

export function listMentionsViaBird(options: {
	maxResults: number;
}): Promise<XurlMentionsResponse> {
	return runEffectPromise(listMentionsViaBirdEffect(options));
}

function listTweetsViaBirdCommandEffect({
	command,
	maxResults,
	all,
	maxPages,
}: {
	command: "likes" | "bookmarks";
	maxResults: number;
	all?: boolean;
	maxPages?: number;
}): Effect.Effect<XurlMentionsResponse, unknown> {
	return Effect.gen(function* () {
		const args = [command, "-n", String(maxResults), "--json"];
		if (all) {
			args.push("--all");
		}
		if (maxPages !== undefined) {
			args.push("--max-pages", String(maxPages));
		}
		const stdout = yield* runBirdJsonCommandEffect(args);
		const payload = yield* parseBirdJsonEffect(stdout);
		return yield* normalizeBirdTweetsPayloadEffect(payload, command);
	});
}

export function listLikedTweetsViaBirdEffect(options: {
	maxResults: number;
	all?: boolean;
	maxPages?: number;
}): Effect.Effect<XurlMentionsResponse, unknown> {
	return listTweetsViaBirdCommandEffect({
		command: "likes",
		...options,
	});
}

export function listLikedTweetsViaBird(options: {
	maxResults: number;
	all?: boolean;
	maxPages?: number;
}): Promise<XurlMentionsResponse> {
	return runEffectPromise(listLikedTweetsViaBirdEffect(options));
}

export function listBookmarkedTweetsViaBirdEffect(options: {
	maxResults: number;
	all?: boolean;
	maxPages?: number;
}): Effect.Effect<XurlMentionsResponse, unknown> {
	return listTweetsViaBirdCommandEffect({
		command: "bookmarks",
		...options,
	});
}

export function listBookmarkedTweetsViaBird(options: {
	maxResults: number;
	all?: boolean;
	maxPages?: number;
}): Promise<XurlMentionsResponse> {
	return runEffectPromise(listBookmarkedTweetsViaBirdEffect(options));
}

export function searchTweetsViaBirdEffect(
	query: string,
	options: {
		maxResults: number;
		all?: boolean;
		maxPages?: number;
	},
): Effect.Effect<XurlMentionsResponse, unknown> {
	return Effect.gen(function* () {
		const args = ["search", query, "-n", String(options.maxResults), "--json"];
		if (options.all) {
			args.push("--all");
		}
		if (options.all && options.maxPages !== undefined) {
			args.push("--max-pages", String(options.maxPages));
		}
		const stdout = yield* runBirdJsonCommandEffect(args);
		const payload = yield* parseBirdJsonEffect(stdout);
		return yield* normalizeBirdTweetsPayloadEffect(payload, "search");
	});
}

export function searchTweetsViaBird(
	query: string,
	options: {
		maxResults: number;
		all?: boolean;
		maxPages?: number;
	},
): Promise<XurlMentionsResponse> {
	return runEffectPromise(searchTweetsViaBirdEffect(query, options));
}

export function lookupTweetsByIdsViaBirdEffect(
	ids: string[],
): Effect.Effect<XurlTweetsResponse, unknown> {
	if (ids.length === 0) {
		return Effect.succeed({ data: [] });
	}

	return Effect.gen(function* () {
		const tweets = yield* Effect.forEach(
			ids,
			(id) =>
				Effect.gen(function* () {
					const stdout = yield* runBirdJsonCommandEffect([
						"read",
						id,
						"--json",
					]);
					const payload = yield* parseBirdJsonEffect(stdout);
					return yield* normalizeBirdTweetItemEffect(payload, "read");
				}),
			{ concurrency: "unbounded" },
		);
		return normalizeBirdTweets(tweets);
	});
}

export function lookupTweetsByIdsViaBird(
	ids: string[],
): Promise<XurlTweetsResponse> {
	return runEffectPromise(lookupTweetsByIdsViaBirdEffect(ids));
}

export function expandRetweetedTextViaBirdEffect(
	tweetId: string,
): Effect.Effect<ExpandedRetweetedText, unknown> {
	return Effect.gen(function* () {
		const stdout = yield* runBirdJsonCommandEffect(
			["read", tweetId, "--json-full"],
			BIRD_EXPAND_TIMEOUT_MS,
		);
		const payload = yield* parseBirdJsonEffect(stdout);
		const item = yield* normalizeBirdTweetItemEffect(payload, "read");
		return yield* Effect.try({
			try: () => expandedRetweetedTextFromBirdItem(item, tweetId),
			catch: (error) => error,
		});
	});
}

export function expandRetweetedTextViaBird(
	tweetId: string,
): Promise<ExpandedRetweetedText> {
	return runEffectPromise(expandRetweetedTextViaBirdEffect(tweetId));
}

export function listHomeTimelineViaBirdEffect({
	maxResults,
	following = true,
}: {
	maxResults: number;
	following?: boolean;
}): Effect.Effect<XurlMentionsResponse, unknown> {
	return Effect.gen(function* () {
		const args = ["home", "-n", String(maxResults), "--json"];
		if (following) {
			args.push("--following");
		}
		const stdout = yield* runBirdJsonCommandEffect(args);
		const payload = yield* parseBirdJsonEffect(stdout);
		const normalized = yield* normalizeBirdTweetsPayloadEffect(payload, "home");
		return yield* hydrateBirdTimelineProfilesEffect(normalized);
	});
}

export function listHomeTimelineViaBird(options: {
	maxResults: number;
	following?: boolean;
}): Promise<XurlMentionsResponse> {
	return runEffectPromise(listHomeTimelineViaBirdEffect(options));
}

function normalizeBirdFollowUsers(
	payload: unknown,
	command: "followers" | "following",
	maxResults: number,
): XurlFollowUsersResponse {
	const rawPayload = payload as BirdFollowUsersPayload;
	const users = Array.isArray(rawPayload) ? rawPayload : rawPayload.users;
	if (!Array.isArray(users)) {
		throw new Error(`bird ${command} returned unexpected JSON`);
	}

	const data = users
		.map(toXurlMentionUser)
		.filter((user): user is XurlMentionUser => Boolean(user));
	const nextToken =
		!Array.isArray(rawPayload) && typeof rawPayload.nextCursor === "string"
			? rawPayload.nextCursor
			: null;

	return {
		data,
		meta: {
			result_count: data.length,
			page_count:
				data.length > 0 ? Math.max(1, Math.ceil(data.length / maxResults)) : 1,
			next_token: nextToken,
		},
	};
}

function normalizeBirdFollowUsersEffect(
	payload: unknown,
	command: "followers" | "following",
	maxResults: number,
) {
	return Effect.try({
		try: () => normalizeBirdFollowUsers(payload, command, maxResults),
		catch: (error) => error,
	});
}

export function listFollowUsersViaBirdEffect({
	direction,
	userId,
	maxResults,
	all,
	maxPages,
}: {
	direction: "followers" | "following";
	userId?: string;
	maxResults: number;
	all?: boolean;
	maxPages?: number;
}): Effect.Effect<XurlFollowUsersResponse, unknown> {
	return Effect.gen(function* () {
		const args = [direction, "-n", String(maxResults), "--json"];
		if (userId) {
			args.push("--user", userId);
		}
		if (all) {
			args.push("--all");
		}
		if (maxPages !== undefined) {
			args.push("--max-pages", String(maxPages));
		}
		const stdout = yield* runBirdJsonCommandEffect(args);
		const payload = yield* parseBirdJsonEffect(stdout);
		return yield* normalizeBirdFollowUsersEffect(
			payload,
			direction,
			maxResults,
		);
	});
}

export function listFollowUsersViaBird(options: {
	direction: "followers" | "following";
	userId?: string;
	maxResults: number;
	all?: boolean;
	maxPages?: number;
}): Promise<XurlFollowUsersResponse> {
	return runEffectPromise(listFollowUsersViaBirdEffect(options));
}

export function listThreadViaBirdEffect({
	tweetId,
	all,
	maxPages,
	timeoutMs,
}: {
	tweetId: string;
	all?: boolean;
	maxPages?: number;
	timeoutMs?: number;
}): Effect.Effect<XurlMentionsResponse, unknown> {
	return Effect.gen(function* () {
		const args = ["thread", tweetId, "--json"];
		if (all) {
			args.push("--all");
		}
		if (maxPages !== undefined) {
			args.push("--max-pages", String(maxPages));
		}
		const stdout = yield* runBirdJsonCommandEffect(args, timeoutMs);
		const payload = yield* parseBirdJsonEffect(stdout);
		return yield* normalizeBirdTweetsPayloadEffect(payload, "thread");
	});
}

export function listThreadViaBird(options: {
	tweetId: string;
	all?: boolean;
	maxPages?: number;
	timeoutMs?: number;
}): Promise<XurlMentionsResponse> {
	return runEffectPromise(listThreadViaBirdEffect(options));
}

function normalizeBirdDmsPayloadEffect(payload: unknown) {
	return Effect.try({
		try: () => {
			if (
				!payload ||
				typeof payload !== "object" ||
				(payload as { success?: unknown }).success !== true ||
				!Array.isArray(
					(payload as { conversations?: unknown }).conversations,
				) ||
				!Array.isArray((payload as { events?: unknown }).events)
			) {
				throw new Error("bird dms returned unexpected JSON");
			}

			return payload as BirdDmsResponse;
		},
		catch: (error) => error,
	});
}

function parseBirdWhoami(stdout: string): BirdAuthenticatedAccount {
	const usernameMatch = stdout.match(/@([A-Za-z0-9_]{1,15})\b/);
	if (!usernameMatch?.[1]) {
		throw new Error("bird whoami did not report an authenticated username");
	}
	const id = stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.map((line) => {
			const labeled = line.match(/(?:🪪|user_?id:?)[^\d]*(\d{2,})/i);
			if (labeled?.[1]) {
				return labeled[1];
			}
			if (/[A-Za-z@]/.test(line)) {
				return undefined;
			}
			return line.match(/^\D*(\d{2,})\D*$/)?.[1];
		})
		.find((value): value is string => Boolean(value));
	return {
		username: usernameMatch[1],
		...(id ? { id } : {}),
	};
}

export function getAuthenticatedBirdAccountEffect(): Effect.Effect<
	BirdAuthenticatedAccount,
	unknown
> {
	return Effect.gen(function* () {
		const stdout = yield* runBirdJsonCommandEffect(["whoami"]);
		return yield* Effect.try({
			try: () => parseBirdWhoami(stdout),
			catch: (error) => error,
		});
	});
}

export function getAuthenticatedBirdAccount(): Promise<BirdAuthenticatedAccount> {
	return runEffectPromise(getAuthenticatedBirdAccountEffect());
}

export function listDirectMessagesViaBirdEffect({
	maxResults,
	inbox = "all",
	maxPages,
	allPages = false,
	pageDelayMs,
}: {
	maxResults: number;
	inbox?: "all" | "accepted" | "requests";
	maxPages?: number;
	allPages?: boolean;
	pageDelayMs?: number;
}): Effect.Effect<BirdDmsResponse, unknown> {
	return Effect.gen(function* () {
		const args = ["dms", "-n", String(maxResults), "--json"];
		if (inbox !== "all") {
			args.push("--inbox", inbox);
		}
		if (allPages) {
			args.push("--all-pages");
		} else if (typeof maxPages === "number") {
			args.push("--max-pages", String(maxPages));
		}
		if (typeof pageDelayMs === "number" && pageDelayMs > 0) {
			args.push("--page-delay-ms", String(pageDelayMs));
		}
		const stdout = yield* runBirdJsonCommandEffect(args);
		const payload = yield* parseBirdJsonEffect(stdout);
		return yield* normalizeBirdDmsPayloadEffect(payload);
	});
}

export function listDirectMessagesViaBird(options: {
	maxResults: number;
	inbox?: "all" | "accepted" | "requests";
	maxPages?: number;
	allPages?: boolean;
	pageDelayMs?: number;
}): Promise<BirdDmsResponse> {
	return runEffectPromise(listDirectMessagesViaBirdEffect(options));
}

export function runDirectMessageRequestMutationViaBirdEffect({
	action,
	conversationId,
	maxPages,
	allPages = false,
}: {
	action: BirdDmRequestAction;
	conversationId: string;
	maxPages?: number;
	allPages?: boolean;
}): Effect.Effect<BirdDmMutationResponse, unknown> {
	return Effect.gen(function* () {
		const command =
			action === "accept"
				? "dm-accept"
				: action === "reject"
					? "dm-reject"
					: "dm-block";
		const args = [command, conversationId, "--json"];
		if (action === "block") {
			if (allPages) {
				args.push("--all-pages");
			} else if (typeof maxPages === "number") {
				args.push("--max-pages", String(maxPages));
			}
		}
		const stdout = yield* runBirdJsonCommandAllowFailureEffect(args);
		const payload = yield* parseBirdJsonEffect(stdout);
		if (
			payload &&
			typeof payload === "object" &&
			typeof (payload as { success?: unknown }).success === "boolean"
		) {
			return payload as BirdDmMutationResponse;
		}
		throw new Error(`bird ${command} returned unexpected JSON`);
	});
}

export function runDirectMessageRequestMutationViaBird(options: {
	action: BirdDmRequestAction;
	conversationId: string;
	maxPages?: number;
	allPages?: boolean;
}): Promise<BirdDmMutationResponse> {
	return runEffectPromise(
		runDirectMessageRequestMutationViaBirdEffect(options),
	);
}

function toXurlMentionUser(
	user: BirdUserOverviewPayload["user"],
): XurlMentionUser | null {
	if (!user?.id || !user.username) {
		return null;
	}

	return {
		id: String(user.id),
		username: String(user.username).replace(/^@/, ""),
		name: String(user.name ?? user.username),
		description:
			typeof user.description === "string" ? user.description : undefined,
		location: typeof user.location === "string" ? user.location : undefined,
		url: typeof user.url === "string" ? user.url : undefined,
		verified: typeof user.verified === "boolean" ? user.verified : undefined,
		verified_type:
			typeof user.verifiedType === "string"
				? user.verifiedType
				: typeof user.verified_type === "string"
					? user.verified_type
					: undefined,
		profile_image_url:
			typeof user.profileImageUrl === "string"
				? user.profileImageUrl
				: undefined,
		entities:
			user.entities && typeof user.entities === "object"
				? user.entities
				: undefined,
		affiliation:
			user.affiliation && typeof user.affiliation === "object"
				? user.affiliation
				: undefined,
		created_at: typeof user.createdAt === "string" ? user.createdAt : undefined,
		public_metrics: {
			followers_count: Number(user.followersCount ?? 0),
			following_count: Number(user.followingCount ?? 0),
		},
	};
}

function profileLookupResultsFromUsers(
	targets: string[],
	users: XurlMentionUser[],
	errors: Map<string, string> = new Map(),
) {
	const byTarget = new Map<string, XurlMentionUser>();
	for (const user of users) {
		byTarget.set(String(user.id).toLowerCase(), user);
		byTarget.set(user.username.toLowerCase(), user);
	}
	return targets.map((target) => {
		const normalizedTarget = target.toLowerCase();
		return {
			target,
			user: byTarget.get(normalizedTarget) ?? null,
			...(errors.has(normalizedTarget)
				? { error: errors.get(normalizedTarget) }
				: {}),
		};
	});
}

function lookupProfilesFromBirdFollowingEffect(
	targets: string[],
): Effect.Effect<
	Array<{ target: string; user: XurlMentionUser | null; error?: string }>,
	unknown
> {
	return Effect.gen(function* () {
		const payload = yield* listFollowUsersViaBirdEffect({
			direction: "following",
			maxResults: 1000,
		});
		return profileLookupResultsFromUsers(targets, payload.data);
	});
}

function lookupProfileViaBirdUserCommandEffect(
	target: string,
): Effect.Effect<XurlMentionUser | null, unknown> {
	return Effect.gen(function* () {
		const stdout = yield* runBirdJsonCommandEffect([
			"user",
			target,
			"--json",
			"--profile-only",
		]).pipe(
			Effect.catchAll((error) => {
				if (!isUnsupportedBirdOptionError(error, "--profile-only")) {
					return Effect.fail(error);
				}
				return runBirdJsonCommandEffect([
					"user",
					target,
					"--json",
					"--count",
					"1",
				]);
			}),
		);
		const payload = (yield* parseBirdJsonEffect(
			stdout,
		)) as BirdUserOverviewPayload;
		return toXurlMentionUser(payload.user);
	});
}

function lookupProfileViaBirdUserTweetsEffect(
	target: string,
): Effect.Effect<XurlMentionUser | null, unknown> {
	return Effect.gen(function* () {
		const stdout = yield* runBirdJsonCommandEffect([
			"user-tweets",
			target,
			"-n",
			"1",
			"--json-full",
		]);
		const payload = yield* parseBirdJsonEffect(stdout);
		const tweets = yield* Effect.try({
			try: () => getBirdTweetItems(payload, "user-tweets"),
			catch: (error) => error,
		});
		for (const tweet of tweets) {
			const user = xUserFromBirdTweet(tweet);
			if (user) {
				return user;
			}
		}
		return null;
	});
}

function lookupProfileViaBirdDirectEffect(target: string) {
	return lookupProfileViaBirdUserCommandEffect(target).pipe(
		Effect.catchAll(() => lookupProfileViaBirdUserTweetsEffect(target)),
	);
}

function lookupProfilesViaBirdUserCommandsEffect(targets: string[]) {
	return Effect.forEach(
		targets,
		(target) =>
			lookupProfileViaBirdDirectEffect(target).pipe(
				Effect.map((user) => ({ target, user })),
				Effect.catchAll((lookupError) =>
					Effect.succeed({
						target,
						user: null,
						error:
							lookupError instanceof Error
								? lookupError.message
								: String(lookupError),
					}),
				),
			),
		{ concurrency: 4 },
	);
}

export function lookupProfilesViaBirdEffect(
	usernameOrIds: string[],
): Effect.Effect<
	Array<{ target: string; user: XurlMentionUser | null; error?: string }>,
	unknown
> {
	const targets = Array.from(
		new Set(
			usernameOrIds
				.map((target) => target.trim().replace(/^@/, ""))
				.filter((target) => target.length > 0),
		),
	);
	if (targets.length === 0) {
		return Effect.succeed([]);
	}

	return runBirdJsonCommandEffect(["profiles", ...targets, "--json"]).pipe(
		Effect.flatMap((stdout) =>
			Effect.gen(function* () {
				const payload = (yield* parseBirdJsonEffect(
					stdout,
				)) as BirdProfilesPayload;
				const users = (payload.users ?? [])
					.map(toXurlMentionUser)
					.filter((user): user is XurlMentionUser => Boolean(user));
				const errors = new Map(
					(payload.errors ?? []).map((item) => [
						String(item.target ?? "")
							.replace(/^@/, "")
							.toLowerCase(),
						item.error ?? "Unknown error",
					]),
				);
				return profileLookupResultsFromUsers(targets, users, errors);
			}),
		),
		Effect.catchAll((error) => {
			if (
				!isUnsupportedBirdCommandError(error, "profiles") &&
				!isUnsupportedBirdOptionError(error, "profiles")
			) {
				return Effect.fail(error);
			}
			return lookupProfilesFromBirdFollowingEffect(targets).pipe(
				Effect.flatMap((followingResults) => {
					const missingTargets = followingResults
						.filter((result) => !result.user)
						.map((result) => result.target);
					if (missingTargets.length === 0) {
						return Effect.succeed(followingResults);
					}
					return lookupProfilesViaBirdUserCommandsEffect(missingTargets).pipe(
						Effect.map((userResults) => {
							const byTarget = new Map(
								userResults.map((result) => [result.target, result]),
							);
							return followingResults.map(
								(result) => byTarget.get(result.target) ?? result,
							);
						}),
					);
				}),
				Effect.catchAll(() => lookupProfilesViaBirdUserCommandsEffect(targets)),
			);
		}),
	);
}

export function lookupProfileViaBirdEffect(
	usernameOrId: string,
): Effect.Effect<XurlMentionUser | null, unknown> {
	return Effect.gen(function* () {
		const target = usernameOrId.trim().replace(/^@/, "");
		if (!target) {
			return null;
		}

		return yield* lookupProfileViaBirdUserCommandEffect(target).pipe(
			Effect.catchAll((error) => {
				if (!isUnsupportedBirdCommandError(error, "user")) {
					return Effect.fail(error);
				}
				return lookupProfilesFromBirdFollowingEffect([target]).pipe(
					Effect.catchAll(() => Effect.succeed([])),
					Effect.flatMap((results) =>
						results[0]?.user
							? Effect.succeed(results[0].user)
							: lookupProfileViaBirdUserTweetsEffect(target),
					),
				);
			}),
		);
	});
}

export function lookupProfileViaBird(
	usernameOrId: string,
): Promise<XurlMentionUser | null> {
	return runEffectPromise(lookupProfileViaBirdEffect(usernameOrId));
}

export function lookupProfilesViaBird(
	usernameOrIds: string[],
): Promise<
	Array<{ target: string; user: XurlMentionUser | null; error?: string }>
> {
	return runEffectPromise(lookupProfilesViaBirdEffect(usernameOrIds));
}

export const __test__ = {
	toIsoTimestamp,
	escapeJsonStringControlChars,
	parseBirdJson,
	formatBirdCommandError,
	isUnsupportedBirdOptionError,
	getBirdTweetItems,
	getBirdTweetItem,
	toMediaEntities,
	toMediaAttachments,
	toXurlMediaItems,
	toTweetEntities,
	toReferencedTweets,
	normalizeBirdTweets,
};
