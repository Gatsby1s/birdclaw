import type { Database } from "./sqlite";
import {
	evaluatePreviousTwillotFallback,
	findCloudFollowingTarget,
	mergeCloudCollectionHandles,
	queueTwillotFallback,
} from "./cloud-twitter-collection";
import { getTwitter6551Config } from "./config";
import { enqueueDatabaseWrite } from "./database-writer";
import { getNativeDb } from "./db";
import {
	FxTwitterClient,
	type FxTwitterConversationEnvelope,
	type FxTwitterSearchEnvelope,
	type FxTwitterStatusEnvelope,
	type FxTwitterTweet,
	fxTwitterTweetsToPayload,
	normalizeFxTwitterTweet,
	normalizeFxTwitterTweets,
} from "./fxtwitter";
import { ingestTweetPayload } from "./tweet-repository";
import {
	readTwitter6551DailyBudget,
	readTwitter6551FallbackState,
	claimTwitter6551PaidFallback,
	recordTwitter6551FxRecovery,
	reserveTwitter6551RequestAttempt,
	twitter6551UsageDay,
	Twitter6551RecoveryStateError,
	Twitter6551RequestBudgetError,
} from "./twitter-6551-state";
import type {
	XurlMedia,
	XurlMentionData,
	XurlMentionsResponse,
	XurlMentionUser,
} from "./types";

const SOURCE = "twitter6551";
const FXTWITTER_SOURCE = "fxtwitter";
const DEFAULT_ACCOUNT_ID = "acct_6551";
const DEFAULT_BACKFILL_MINUTES = 120;
const REQUEST_TIMEOUT_MS = 30_000;
const HEARTBEAT_MS = 25_000;
const STALE_CONNECTION_MS = 75_000;
const SUBSCRIPTION_TIMEOUT_MS = 15_000;
const MAX_RECONNECT_MS = 60_000;
const AUTH_RECONNECT_MS = 5 * 60_000;
const DEFAULT_LOCAL_STALE_SECONDS = 180;
const FAILOVER_CHECK_MS = 15_000;
const DEFAULT_PAID_FALLBACK_FAILURE_THRESHOLD = 3;
const DEFAULT_PAID_FALLBACK_COOLDOWN_MINUTES = 360;
const DEFAULT_PAID_DAILY_REQUEST_BUDGET = 24;
const DEFAULT_TWILLOT_FALLBACK_TIMEOUT_MINUTES = 30;

type JsonRecord = Record<string, unknown>;

export interface Twitter6551User {
	userId: string;
	screenName: string;
	name: string;
	description?: string;
	followersCount?: number;
	friendsCount?: number;
	verified?: boolean;
	profileImageUrl?: string;
	profileBannerUrl?: string;
}

export interface Twitter6551Tweet {
	id: string;
	text: string;
	createdAt: string;
	userId: string;
	userScreenName: string;
	userName: string;
	userFollowers?: number;
	userVerified?: boolean;
	conversationId?: string;
	replyId?: string;
	quotedTweetId?: string;
	favoriteCount?: number;
	retweetCount?: number;
	replyCount?: number;
	quoteCount?: number;
	viewCount?: number;
	media: Array<{
		type: string;
		url: string;
		thumbUrl?: string;
	}>;
	urls: Array<{
		url: string;
		expandedUrl?: string;
		displayUrl?: string;
	}>;
	mentions: Array<{ username: string; name?: string }>;
	hashtags: string[];
	raw: JsonRecord;
}

export interface Twitter6551RuntimeStatus {
	enabled: boolean;
	provider: "disabled" | "fxtwitter" | "6551";
	state:
		| "disabled"
		| "starting"
		| "connecting"
		| "connected"
		| "polling"
		| "degraded"
		| "error"
		| "standby"
		| "stopped";
	connected: boolean;
	failoverMode: boolean;
	activeSource:
		| "disabled"
		| "waiting"
		| "local"
		| "fxtwitter"
		| "twillot"
		| "6551";
	watchUsers: string[];
	cloudAllFollowing: boolean;
	twillotCloudFallbackEnabled: boolean;
	twillotFallbackTimeoutMinutes: number;
	twillotPendingCount: number;
	twillotCompletedCount: number;
	twillotFailedCount: number;
	targetTweetIds: string[];
	lastConnectedAt: string | null;
	lastEventAt: string | null;
	lastBackfillAt: string | null;
	lastPaidFallbackAt: string | null;
	lastLocalHeartbeatAt: string | null;
	localStaleSeconds: number;
	localBridgeIngestedCount: number;
	lastError: string | null;
	reconnectCount: number;
	ingestedCount: number;
	fxConsecutiveTotalFailures: number;
	paidFallbackFailureThreshold: number;
	paidFallbackCooldownMinutes: number;
	paidBudgetDay: string;
	paidRequestsToday: number;
	paidDailyRequestBudget: number;
	paidRequestsRemaining: number;
}

export class Twitter6551Error extends Error {
	constructor(
		message: string,
		public readonly status?: number,
	) {
		super(message);
		this.name = "Twitter6551Error";
	}
}

export class Twitter6551PaidRequestSuppressedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "Twitter6551PaidRequestSuppressedError";
	}
}

function record(value: unknown): JsonRecord | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as JsonRecord)
		: null;
}

function stringValue(value: unknown) {
	if (typeof value === "string" && value.trim()) return value.trim();
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return undefined;
}

function numberValue(value: unknown) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function booleanValue(value: unknown) {
	return typeof value === "boolean" ? value : undefined;
}

function normalizedHandle(value: unknown) {
	return stringValue(value)?.replace(/^@/, "");
}

function stringList(value: unknown) {
	return Array.isArray(value)
		? value
				.map((item) => stringValue(item))
				.filter((item): item is string => Boolean(item))
		: [];
}

function parseMaybeJson(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return value;
	}
}

function safeDate(value: unknown) {
	const raw = stringValue(value);
	if (!raw) return new Date().toISOString();
	const date = new Date(raw);
	return Number.isNaN(date.getTime())
		? new Date().toISOString()
		: date.toISOString();
}

function normalizeMedia(value: unknown): Twitter6551Tweet["media"] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		const media = record(item);
		const url = stringValue(media?.url);
		if (!media || !url) return [];
		return [
			{
				type: stringValue(media.type) ?? "unknown",
				url,
				...(stringValue(media.thumbUrl ?? media.thumbnailUrl)
					? {
							thumbUrl: stringValue(
								media.thumbUrl ?? media.thumbnailUrl,
							) as string,
						}
					: {}),
			},
		];
	});
}

function normalizeUrls(value: unknown): Twitter6551Tweet["urls"] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		const url = record(item);
		const compact = stringValue(url?.url);
		if (!url || !compact) return [];
		return [
			{
				url: compact,
				...(stringValue(url.expandedUrl ?? url.expanded_url)
					? {
							expandedUrl: stringValue(
								url.expandedUrl ?? url.expanded_url,
							) as string,
						}
					: {}),
				...(stringValue(url.displayUrl ?? url.display_url)
					? {
							displayUrl: stringValue(
								url.displayUrl ?? url.display_url,
							) as string,
						}
					: {}),
			},
		];
	});
}

function normalizeMentions(value: unknown): Twitter6551Tweet["mentions"] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		const mention = record(item);
		const username = normalizedHandle(mention?.username ?? mention?.screenName);
		if (!mention || !username) return [];
		return [
			{
				username,
				...(stringValue(mention.name)
					? { name: stringValue(mention.name) as string }
					: {}),
			},
		];
	});
}

export function normalizeTwitter6551User(
	value: unknown,
): Twitter6551User | null {
	const user = record(value);
	if (!user) return null;
	const userId = stringValue(user.userId ?? user.userIdStr ?? user.id);
	const screenName = normalizedHandle(
		user.screenName ?? user.userScreenName ?? user.twAccount,
	);
	if (!userId || !screenName) return null;
	return {
		userId,
		screenName,
		name:
			stringValue(user.name ?? user.userName ?? user.twUserName) ?? screenName,
		...(stringValue(user.description)
			? { description: stringValue(user.description) as string }
			: {}),
		...(numberValue(user.followersCount ?? user.userFollowers) !== undefined
			? {
					followersCount: numberValue(
						user.followersCount ?? user.userFollowers,
					),
				}
			: {}),
		...(numberValue(user.friendsCount) !== undefined
			? { friendsCount: numberValue(user.friendsCount) }
			: {}),
		...(booleanValue(user.verified ?? user.userVerified) !== undefined
			? { verified: booleanValue(user.verified ?? user.userVerified) }
			: {}),
		...(stringValue(user.profileImageUrl)
			? { profileImageUrl: stringValue(user.profileImageUrl) as string }
			: {}),
		...(stringValue(user.profileBannerUrl)
			? { profileBannerUrl: stringValue(user.profileBannerUrl) as string }
			: {}),
	};
}

export function normalizeTwitter6551Tweet(
	value: unknown,
	fallbackUser?: Partial<Twitter6551User>,
): Twitter6551Tweet | null {
	const tweet = record(parseMaybeJson(value));
	if (!tweet) return null;
	const id = stringValue(tweet.id ?? tweet.twId);
	const userId = stringValue(
		tweet.userIdStr ?? tweet.userId ?? fallbackUser?.userId,
	);
	const userScreenName = normalizedHandle(
		tweet.userScreenName ??
			tweet.screenName ??
			tweet.twAccount ??
			fallbackUser?.screenName,
	);
	const text = stringValue(tweet.text ?? tweet.content) ?? "";
	if (!id || !userId || !userScreenName) return null;
	const quoted = record(tweet.quotedStatus);
	return {
		id,
		text,
		createdAt: safeDate(tweet.createdAt ?? tweet.created_at),
		userId,
		userScreenName,
		userName:
			stringValue(tweet.userName ?? tweet.twUserName ?? fallbackUser?.name) ??
			userScreenName,
		...(numberValue(tweet.userFollowers ?? fallbackUser?.followersCount) !==
		undefined
			? {
					userFollowers: numberValue(
						tweet.userFollowers ?? fallbackUser?.followersCount,
					),
				}
			: {}),
		...(booleanValue(tweet.userVerified ?? fallbackUser?.verified) !== undefined
			? {
					userVerified: booleanValue(
						tweet.userVerified ?? fallbackUser?.verified,
					),
				}
			: {}),
		...(stringValue(tweet.conversationId)
			? { conversationId: stringValue(tweet.conversationId) as string }
			: {}),
		...(stringValue(tweet.replyId ?? tweet.inReplyToStatusId)
			? {
					replyId: stringValue(
						tweet.replyId ?? tweet.inReplyToStatusId,
					) as string,
				}
			: {}),
		...(stringValue(tweet.quotedTweetId ?? quoted?.id)
			? {
					quotedTweetId: stringValue(
						tweet.quotedTweetId ?? quoted?.id,
					) as string,
				}
			: {}),
		...(numberValue(tweet.favoriteCount) !== undefined
			? { favoriteCount: numberValue(tweet.favoriteCount) }
			: {}),
		...(numberValue(tweet.retweetCount) !== undefined
			? { retweetCount: numberValue(tweet.retweetCount) }
			: {}),
		...(numberValue(tweet.replyCount) !== undefined
			? { replyCount: numberValue(tweet.replyCount) }
			: {}),
		...(numberValue(tweet.quoteCount) !== undefined
			? { quoteCount: numberValue(tweet.quoteCount) }
			: {}),
		...(numberValue(tweet.viewCount) !== undefined
			? { viewCount: numberValue(tweet.viewCount) }
			: {}),
		media: normalizeMedia(tweet.media),
		urls: normalizeUrls(tweet.urls),
		mentions: normalizeMentions(tweet.mentions),
		hashtags: stringList(tweet.hashtags),
		raw: tweet,
	};
}

export function twitter6551UserToXurl(user: Twitter6551User): XurlMentionUser {
	return {
		id: user.userId,
		username: user.screenName,
		name: user.name,
		...(user.description ? { description: user.description } : {}),
		...(user.profileImageUrl
			? { profile_image_url: user.profileImageUrl }
			: {}),
		...(user.verified !== undefined ? { verified: user.verified } : {}),
		public_metrics: {
			...(user.followersCount !== undefined
				? { followers_count: user.followersCount }
				: {}),
			...(user.friendsCount !== undefined
				? { following_count: user.friendsCount }
				: {}),
		},
	};
}

function tweetToXurl(tweet: Twitter6551Tweet): {
	tweet: XurlMentionData;
	user: XurlMentionUser;
	media: XurlMedia[];
} {
	const media: XurlMedia[] = tweet.media.map((item, index) => ({
		media_key: `${tweet.id}:${String(index)}`,
		type:
			item.type === "image"
				? "photo"
				: item.type === "gif"
					? "animated_gif"
					: item.type,
		url: item.url,
		...(item.thumbUrl ? { preview_image_url: item.thumbUrl } : {}),
	}));
	const references = [
		...(tweet.replyId ? [{ type: "replied_to", id: tweet.replyId }] : []),
		...(tweet.quotedTweetId
			? [{ type: "quoted", id: tweet.quotedTweetId }]
			: []),
	];
	return {
		tweet: {
			id: tweet.id,
			author_id: tweet.userId,
			text: tweet.text,
			created_at: tweet.createdAt,
			...(tweet.conversationId
				? { conversation_id: tweet.conversationId }
				: {}),
			...(media.length > 0
				? { attachments: { media_keys: media.map((item) => item.media_key) } }
				: {}),
			entities: {
				...(tweet.urls.length > 0
					? {
							urls: tweet.urls.map((url) => ({
								url: url.url,
								expanded_url: url.expandedUrl ?? url.url,
								display_url: url.displayUrl ?? url.expandedUrl ?? url.url,
								start: 0,
								end: 0,
							})),
						}
					: {}),
				...(tweet.mentions.length > 0
					? {
							mentions: tweet.mentions.map((mention) => ({
								username: mention.username,
								start: 0,
								end: 0,
							})),
						}
					: {}),
				...(tweet.hashtags.length > 0
					? {
							hashtags: tweet.hashtags.map((tag) => ({
								tag,
								start: 0,
								end: 0,
							})),
						}
					: {}),
			},
			...(references.length > 0 ? { referenced_tweets: references } : {}),
			public_metrics: {
				like_count: tweet.favoriteCount ?? 0,
				retweet_count: tweet.retweetCount ?? 0,
				reply_count: tweet.replyCount ?? 0,
				quote_count: tweet.quoteCount ?? 0,
				impression_count: tweet.viewCount ?? 0,
			},
		},
		user: twitter6551UserToXurl({
			userId: tweet.userId,
			screenName: tweet.userScreenName,
			name: tweet.userName,
			...(tweet.userFollowers !== undefined
				? { followersCount: tweet.userFollowers }
				: {}),
			...(tweet.userVerified !== undefined
				? { verified: tweet.userVerified }
				: {}),
		}),
		media,
	};
}

export function twitter6551TweetsToPayload(
	tweets: Twitter6551Tweet[],
): XurlMentionsResponse {
	const converted = tweets.map(tweetToXurl);
	const users = [
		...new Map(converted.map((item) => [item.user.id, item.user])).values(),
	];
	return {
		data: converted.map((item) => item.tweet),
		includes: {
			users,
			media: converted.flatMap((item) => item.media),
		},
		meta: { result_count: converted.length, source: SOURCE },
	};
}

export function ensureTwitter6551Account(
	db: Database,
	accountId = DEFAULT_ACCOUNT_ID,
	provider: "fxtwitter" | "6551" = "6551",
) {
	const now = new Date().toISOString();
	const handle =
		accountId === DEFAULT_ACCOUNT_ID
			? provider === "fxtwitter"
				? "@fxtwitter_recovery"
				: "@6551_watch"
			: `@${accountId.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40)}`;
	const name = provider === "fxtwitter" ? "FxTwitter Recovery" : "6551 Watch";
	const transport = provider === "fxtwitter" ? "fxtwitter" : "twitter6551";
	db.prepare(
		`
		insert into accounts (
			id, name, handle, external_user_id, transport, is_default, created_at
		) values (?, ?, ?, null, ?,
			case when exists(select 1 from accounts) then 0 else 1 end, ?)
		on conflict(id) do update set transport = case
			when accounts.transport in ('twitter6551', 'fxtwitter') then excluded.transport
			else accounts.transport
		end
		`,
	).run(accountId, name, handle, transport, now);
	return accountId;
}

export function ingestTwitter6551Tweets(
	db: Database,
	accountId: string,
	tweets: Twitter6551Tweet[],
	edgeKind: "home" | "profile" | "thread_context" = "home",
	preserveExistingCanonical = false,
) {
	if (tweets.length === 0) return [];
	ensureTwitter6551Account(db, accountId);
	return ingestTweetPayload(db, {
		accountId,
		payload: twitter6551TweetsToPayload(tweets),
		source: SOURCE,
		edgeKind,
		markRepliesAsReplied: false,
		preserveExistingCanonical,
	});
}

export interface Twitter6551ClientOptions {
	token: string;
	baseUrl?: string;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	sleep?: (ms: number) => Promise<void>;
	beforeRequestAttempt?: () => Promise<void>;
}

function validatedBaseUrl(value: string) {
	const url = new URL(value);
	if (url.protocol !== "https:" || url.hostname !== "ai.6551.io") {
		throw new Twitter6551Error(
			"6551 base URL must be https://ai.6551.io to protect the API token",
		);
	}
	return url.toString().replace(/\/$/, "");
}

async function defaultSleep(ms: number) {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

export class Twitter6551Client {
	private readonly baseUrl: string;
	private readonly fetchImpl: typeof fetch;
	private readonly timeoutMs: number;
	private readonly sleep: (ms: number) => Promise<void>;

	constructor(private readonly options: Twitter6551ClientOptions) {
		if (!options.token.trim()) {
			throw new Twitter6551Error("6551 API token is missing");
		}
		this.baseUrl = validatedBaseUrl(
			options.baseUrl?.trim() || "https://ai.6551.io",
		);
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
		this.sleep = options.sleep ?? defaultSleep;
	}

	private async request<T>(endpoint: string, body: JsonRecord): Promise<T> {
		let lastError: unknown;
		for (let attempt = 0; attempt < 3; attempt += 1) {
			// The gate is deliberately outside the retry catch and before the network
			// timeout. A suppressed or unverified request must neither retry nor spend
			// an allowance on an already-aborted fetch.
			await this.options.beforeRequestAttempt?.();
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), this.timeoutMs);
			try {
				const response = await this.fetchImpl(
					`${this.baseUrl}/open/${endpoint}`,
					{
						method: "POST",
						headers: {
							authorization: `Bearer ${this.options.token}`,
							"content-type": "application/json",
						},
						body: JSON.stringify(body),
						signal: controller.signal,
					},
				);
				const payload = (await response.json().catch(() => null)) as unknown;
				const payloadRecord = record(payload);
				if (
					!response.ok ||
					(payloadRecord && payloadRecord.success === false)
				) {
					const message =
						stringValue(
							payloadRecord?.message ??
								payloadRecord?.msg ??
								payloadRecord?.error,
						) ?? `6551 request failed (${String(response.status)})`;
					const error = new Twitter6551Error(message, response.status);
					if (
						attempt < 2 &&
						(response.status === 429 || response.status >= 500)
					) {
						lastError = error;
						await this.sleep(500 * 2 ** attempt);
						continue;
					}
					throw error;
				}
				return (payloadRecord?.data ?? payload) as T;
			} catch (error) {
				if (
					error instanceof Twitter6551Error ||
					error instanceof Twitter6551RequestBudgetError ||
					error instanceof Twitter6551RecoveryStateError ||
					error instanceof Twitter6551PaidRequestSuppressedError
				) {
					throw error;
				}
				lastError = error;
				if (attempt < 2) {
					await this.sleep(500 * 2 ** attempt);
					continue;
				}
			} finally {
				clearTimeout(timer);
			}
		}
		throw new Twitter6551Error(
			lastError instanceof Error ? lastError.message : "6551 request failed",
		);
	}

	async getUser(username: string) {
		const data = await this.request<unknown>("twitter_user_info", {
			username: normalizedHandle(username),
		});
		const user = normalizeTwitter6551User(data);
		if (!user) throw new Twitter6551Error("6551 returned an invalid user");
		return user;
	}

	async getUserTweets(username: string, maxResults = 100) {
		const user = await this.getUser(username);
		const data = await this.request<unknown>("twitter_user_tweets", {
			username: user.screenName,
			maxResults: Math.max(1, Math.min(100, Math.floor(maxResults))),
			product: "Latest",
			includeReplies: true,
			includeRetweets: true,
		});
		const rows = Array.isArray(data) ? data : [];
		return rows
			.map((tweet) => normalizeTwitter6551Tweet(tweet, user))
			.filter((tweet): tweet is Twitter6551Tweet => Boolean(tweet));
	}

	async getTweet(tweetId: string) {
		const data = await this.request<unknown>("twitter_tweet_by_id", {
			twId: tweetId,
		});
		const tweet = normalizeTwitter6551Tweet(data);
		if (!tweet) throw new Twitter6551Error("6551 returned an invalid tweet");
		return tweet;
	}

	async getQuoteTweets(tweetId: string, maxResults = 100) {
		const data = await this.request<unknown>("twitter_quote_tweets_by_id", {
			id: tweetId,
			maxResults: Math.max(1, Math.min(100, Math.floor(maxResults))),
		});
		return (Array.isArray(data) ? data : [])
			.map((tweet) => normalizeTwitter6551Tweet(tweet))
			.filter((tweet): tweet is Twitter6551Tweet => Boolean(tweet));
	}

	async searchTweets(keywords: string, maxResults = 100) {
		const data = await this.request<unknown>("twitter_search", {
			keywords,
			maxResults: Math.max(1, Math.min(100, Math.floor(maxResults))),
			product: "Latest",
			excludeRetweets: true,
		});
		return (Array.isArray(data) ? data : [])
			.map((tweet) => normalizeTwitter6551Tweet(tweet))
			.filter((tweet): tweet is Twitter6551Tweet => Boolean(tweet));
	}

	async addWatch(username: string) {
		return this.request<unknown>("twitter_watch_add", {
			username: normalizedHandle(username),
			newTweetBol: true,
			newTweetReplyBol: true,
			newTweetQuoteBol: true,
			newRetweetBol: true,
			updateNameBol: false,
			updateDescBol: false,
			updateAvatarBol: false,
			updateBannerBol: false,
		});
	}
}

function ensureTwitter6551Tables(db: Database) {
	db.exec(`
		create table if not exists twitter6551_events (
			event_id text primary key,
			event_type text not null,
			watch_user text not null,
			tweet_id text,
			raw_json text not null,
			received_at text not null,
			processed_at text,
			error text
		);
		create index if not exists idx_twitter6551_events_pending
			on twitter6551_events(processed_at, received_at);
	`);
}

function listEnv(value: string | undefined) {
	return [
		...new Set(
			(value ?? "")
				.split(",")
				.map((item) => item.trim().replace(/^@/, ""))
				.filter(Boolean),
		),
	];
}

function positiveEnvNumber(name: string, fallback: number) {
	const value = Number(process.env[name]);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function failClosedPositiveEnvInteger(name: string, fallback: number) {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw);
	return Number.isInteger(value) && value > 0 ? value : Number.MAX_SAFE_INTEGER;
}

function failClosedPositiveEnvNumber(name: string, fallback: number) {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : Number.MAX_SAFE_INTEGER;
}

function dailyBudgetEnvInteger(name: string, fallback: number) {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw);
	return Number.isInteger(value) && value >= 0 ? value : 0;
}

function cloudAllFollowingEnabled() {
	return process.env.BIRDCLAW_CLOUD_ALL_FOLLOWING_ENABLED === "1";
}

function twillotCloudFallbackEnabled() {
	return process.env.BIRDCLAW_TWILLOT_CLOUD_FALLBACK_ENABLED === "1";
}

function twillotFallbackTimeoutMinutes() {
	return positiveEnvNumber(
		"BIRDCLAW_TWILLOT_FALLBACK_TIMEOUT_MINUTES",
		DEFAULT_TWILLOT_FALLBACK_TIMEOUT_MINUTES,
	);
}

export function getTwitter6551RuntimeConfig() {
	const base = getTwitter6551Config();
	const token =
		process.env[base.tokenEnv]?.trim() ||
		process.env.OPENNEWS_TOKEN?.trim() ||
		"";
	const watchUsers = listEnv(
		process.env.BIRDCLAW_6551_WATCH_USERS ?? base.watchUsers.join(","),
	);
	const targetTweetIds = listEnv(
		process.env.BIRDCLAW_6551_TARGET_TWEETS ?? base.targetTweetIds.join(","),
	);
	const paidEnabled =
		process.env.BIRDCLAW_6551_ENABLED === "1" && Boolean(token);
	const fxtwitterEnabled = process.env.BIRDCLAW_FXTWITTER_ENABLED === "1";
	const provider = fxtwitterEnabled
		? ("fxtwitter" as const)
		: paidEnabled
			? ("6551" as const)
			: ("disabled" as const);
	return {
		...base,
		token,
		paidEnabled,
		fxtwitterEnabled,
		provider,
		enabled:
			(paidEnabled || fxtwitterEnabled) &&
			(watchUsers.length > 0 ||
				targetTweetIds.length > 0 ||
				cloudAllFollowingEnabled()),
		accountId:
			process.env.BIRDCLAW_6551_ACCOUNT_ID?.trim() ||
			base.accountId ||
			DEFAULT_ACCOUNT_ID,
		watchUsers,
		targetTweetIds,
		backfillMinutes: fxtwitterEnabled
			? positiveEnvNumber(
					"BIRDCLAW_FXTWITTER_BACKFILL_MINUTES",
					base.backfillMinutes || DEFAULT_BACKFILL_MINUTES,
				)
			: positiveEnvNumber(
					"BIRDCLAW_6551_BACKFILL_MINUTES",
					base.backfillMinutes || DEFAULT_BACKFILL_MINUTES,
				),
		restOnly: fxtwitterEnabled || process.env.BIRDCLAW_6551_REST_ONLY === "1",
		failoverMode: process.env.BIRDCLAW_6551_FAILOVER_MODE === "1",
		localStaleSeconds: positiveEnvNumber(
			"BIRDCLAW_LOCAL_STALE_SECONDS",
			DEFAULT_LOCAL_STALE_SECONDS,
		),
		paidFallbackFailureThreshold: failClosedPositiveEnvInteger(
			"BIRDCLAW_6551_PAID_FALLBACK_FAILURE_THRESHOLD",
			DEFAULT_PAID_FALLBACK_FAILURE_THRESHOLD,
		),
		paidFallbackCooldownMinutes: failClosedPositiveEnvNumber(
			"BIRDCLAW_6551_PAID_FALLBACK_COOLDOWN_MINUTES",
			DEFAULT_PAID_FALLBACK_COOLDOWN_MINUTES,
		),
		paidDailyRequestBudget: dailyBudgetEnvInteger(
			"BIRDCLAW_6551_PAID_DAILY_REQUEST_BUDGET",
			DEFAULT_PAID_DAILY_REQUEST_BUDGET,
		),
	};
}

let lastLocalHeartbeatAtMs = 0;
let localBridgeIngestedCount = 0;

function emptyStatus(): Twitter6551RuntimeStatus {
	const config = getTwitter6551RuntimeConfig();
	return {
		enabled: config.enabled,
		provider: config.enabled ? config.provider : "disabled",
		state: config.enabled
			? config.failoverMode
				? "standby"
				: "starting"
			: "disabled",
		connected: false,
		failoverMode: config.failoverMode,
		activeSource: config.enabled
			? config.failoverMode
				? "waiting"
				: config.provider
			: "disabled",
		watchUsers: config.watchUsers,
		cloudAllFollowing: cloudAllFollowingEnabled(),
		twillotCloudFallbackEnabled: twillotCloudFallbackEnabled(),
		twillotFallbackTimeoutMinutes: twillotFallbackTimeoutMinutes(),
		twillotPendingCount: 0,
		twillotCompletedCount: 0,
		twillotFailedCount: 0,
		targetTweetIds: config.targetTweetIds,
		lastConnectedAt: null,
		lastEventAt: null,
		lastBackfillAt: null,
		lastPaidFallbackAt: null,
		lastLocalHeartbeatAt: lastLocalHeartbeatAtMs
			? new Date(lastLocalHeartbeatAtMs).toISOString()
			: null,
		localStaleSeconds: config.localStaleSeconds,
		localBridgeIngestedCount,
		lastError: null,
		reconnectCount: 0,
		ingestedCount: 0,
		fxConsecutiveTotalFailures: 0,
		paidFallbackFailureThreshold: config.paidFallbackFailureThreshold,
		paidFallbackCooldownMinutes: config.paidFallbackCooldownMinutes,
		paidBudgetDay: twitter6551UsageDay(),
		paidRequestsToday: 0,
		paidDailyRequestBudget: config.paidDailyRequestBudget,
		paidRequestsRemaining: config.paidDailyRequestBudget,
	};
}

const INITIAL_RUNTIME_STATUS: Twitter6551RuntimeStatus = {
	enabled: false,
	provider: "disabled",
	state: "disabled",
	connected: false,
	failoverMode: false,
	activeSource: "disabled",
	watchUsers: [],
	cloudAllFollowing: false,
	twillotCloudFallbackEnabled: false,
	twillotFallbackTimeoutMinutes: DEFAULT_TWILLOT_FALLBACK_TIMEOUT_MINUTES,
	twillotPendingCount: 0,
	twillotCompletedCount: 0,
	twillotFailedCount: 0,
	targetTweetIds: [],
	lastConnectedAt: null,
	lastEventAt: null,
	lastBackfillAt: null,
	lastPaidFallbackAt: null,
	lastLocalHeartbeatAt: null,
	localStaleSeconds: DEFAULT_LOCAL_STALE_SECONDS,
	localBridgeIngestedCount: 0,
	lastError: null,
	reconnectCount: 0,
	ingestedCount: 0,
	fxConsecutiveTotalFailures: 0,
	paidFallbackFailureThreshold: DEFAULT_PAID_FALLBACK_FAILURE_THRESHOLD,
	paidFallbackCooldownMinutes: DEFAULT_PAID_FALLBACK_COOLDOWN_MINUTES,
	paidBudgetDay: twitter6551UsageDay(),
	paidRequestsToday: 0,
	paidDailyRequestBudget: DEFAULT_PAID_DAILY_REQUEST_BUDGET,
	paidRequestsRemaining: DEFAULT_PAID_DAILY_REQUEST_BUDGET,
};
const RUNTIME_STATUS_KEY = Symbol.for("birdclaw.twitter6551.runtime-status");
const RECOVERY_ATTEMPTS_KEY = Symbol.for(
	"birdclaw.twitter6551.recovery-attempts",
);
type RecoveryAttempt = {
	attemptedAt: number;
	outcome: "running" | "success" | "partial" | "failed";
	error: string | null;
	lastBackfillAt: string | null;
};
const runtimeGlobal = globalThis as typeof globalThis & Record<symbol, unknown>;
let runtimeStatus =
	(runtimeGlobal[RUNTIME_STATUS_KEY] as Twitter6551RuntimeStatus | undefined) ??
	INITIAL_RUNTIME_STATUS;
runtimeGlobal[RUNTIME_STATUS_KEY] = runtimeStatus;
const recoveryAttempts =
	(runtimeGlobal[RECOVERY_ATTEMPTS_KEY] as
		| Map<string, RecoveryAttempt>
		| undefined) ?? new Map<string, RecoveryAttempt>();
runtimeGlobal[RECOVERY_ATTEMPTS_KEY] = recoveryAttempts;

function assignRuntimeStatus(next: Twitter6551RuntimeStatus) {
	runtimeStatus = next;
	runtimeGlobal[RUNTIME_STATUS_KEY] = next;
}

type Twitter6551RuntimeConfig = ReturnType<typeof getTwitter6551RuntimeConfig>;

function recoveryScopeForConfig(
	config: Pick<
		Twitter6551RuntimeConfig,
		"accountId" | "watchUsers" | "targetTweetIds" | "fxtwitterEnabled"
	>,
) {
	return JSON.stringify({
		provider: config.fxtwitterEnabled ? "fxtwitter" : "6551",
		accountId: config.accountId,
		watchUsers: [...config.watchUsers].sort(),
		targetTweetIds: [...config.targetTweetIds].sort(),
	});
}

function applyBudgetStatus(
	budget: ReturnType<typeof readTwitter6551DailyBudget>,
) {
	assignRuntimeStatus({
		...runtimeStatus,
		paidBudgetDay: budget.day,
		paidRequestsToday: budget.attempts,
		paidDailyRequestBudget: budget.limit,
		paidRequestsRemaining: budget.remaining,
	});
}

function applyFallbackStatus(
	state: ReturnType<typeof readTwitter6551FallbackState>,
) {
	assignRuntimeStatus({
		...runtimeStatus,
		fxConsecutiveTotalFailures: state.consecutiveFxTotalFailures,
		lastPaidFallbackAt: state.lastPaidFallbackAt,
	});
}

async function reservePaidTwitter6551Request(
	config: Pick<Twitter6551RuntimeConfig, "paidDailyRequestBudget">,
) {
	try {
		const budget = await enqueueDatabaseWrite((db) =>
			reserveTwitter6551RequestAttempt(
				db,
				config.paidDailyRequestBudget,
				new Date(),
			),
		);
		applyBudgetStatus(budget);
		return budget;
	} catch (error) {
		if (error instanceof Twitter6551RequestBudgetError) throw error;
		throw new Twitter6551RequestBudgetError(
			`6551 paid request budget could not be verified; requests are blocked (${errorMessage(error)})`,
		);
	}
}

export function createBudgetedTwitter6551Client(
	config = getTwitter6551RuntimeConfig(),
	options: { shouldSuppress?: () => boolean } = {},
) {
	return new Twitter6551Client({
		token: config.token,
		baseUrl: config.baseUrl,
		beforeRequestAttempt: async () => {
			if (options.shouldSuppress?.()) {
				throw new Twitter6551PaidRequestSuppressedError(
					"6551 paid recovery was suppressed because the local BirdClaw bridge recovered",
				);
			}
			await reservePaidTwitter6551Request(config);
		},
	});
}

function refreshPersistentTwitter6551Status(config: Twitter6551RuntimeConfig) {
	let budget: ReturnType<typeof readTwitter6551DailyBudget> | undefined;
	try {
		budget = readTwitter6551DailyBudget(
			getNativeDb({ seedDemoData: false }),
			config.paidDailyRequestBudget,
		);
	} catch {
		budget = {
			day: twitter6551UsageDay(),
			attempts: config.paidDailyRequestBudget,
			limit: config.paidDailyRequestBudget,
			remaining: 0,
		};
	}
	let fallback: ReturnType<typeof readTwitter6551FallbackState> | undefined;
	if (config.fxtwitterEnabled) {
		try {
			fallback = readTwitter6551FallbackState(
				getNativeDb({ seedDemoData: false }),
				config.accountId,
				recoveryScopeForConfig(config),
			);
		} catch {
			fallback = undefined;
		}
	}
	assignRuntimeStatus({
		...runtimeStatus,
		paidBudgetDay: budget.day,
		paidRequestsToday: budget.attempts,
		paidDailyRequestBudget: budget.limit,
		paidRequestsRemaining: budget.remaining,
		fxConsecutiveTotalFailures:
			fallback?.consecutiveFxTotalFailures ??
			runtimeStatus.fxConsecutiveTotalFailures,
		lastPaidFallbackAt:
			fallback?.lastPaidFallbackAt ?? runtimeStatus.lastPaidFallbackAt,
	});
}

let activeWorker: Twitter6551Worker | null = null;

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function websocketUrl(baseUrl: string, token: string) {
	const base = new URL(validatedBaseUrl(baseUrl));
	base.protocol = "wss:";
	base.pathname = "/open/twitter_wss";
	base.search = "";
	base.searchParams.set("token", token);
	return base.toString();
}

type Twitter6551WorkerConfigInput = Omit<
	Twitter6551RuntimeConfig,
	| "restOnly"
	| "paidEnabled"
	| "fxtwitterEnabled"
	| "provider"
	| "paidFallbackFailureThreshold"
	| "paidFallbackCooldownMinutes"
	| "paidDailyRequestBudget"
> &
	Partial<
		Pick<
			Twitter6551RuntimeConfig,
			| "restOnly"
			| "paidEnabled"
			| "fxtwitterEnabled"
			| "provider"
			| "paidFallbackFailureThreshold"
			| "paidFallbackCooldownMinutes"
			| "paidDailyRequestBudget"
		>
	>;

export class Twitter6551Worker {
	private socket: WebSocket | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private backfillTimer: ReturnType<typeof setTimeout> | null = null;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private subscriptionTimer: ReturnType<typeof setTimeout> | null = null;
	private stopped = false;
	private lastSocketActivityAt = 0;
	private reconnectAttempt = 0;
	private backfillRunning = false;
	private watchUnavailable = false;
	private hasSubscribedOnce = false;
	private readonly inFlight = new Set<Promise<unknown>>();
	private readonly config: Twitter6551RuntimeConfig;
	private readonly client: Twitter6551Client | null;
	private readonly fxtwitter: FxTwitterClient;

	constructor(
		config: Twitter6551WorkerConfigInput = getTwitter6551RuntimeConfig(),
		client?: Twitter6551Client,
		fxtwitter = new FxTwitterClient(),
	) {
		const fxtwitterEnabled = Boolean(config.fxtwitterEnabled);
		const paidEnabled = config.paidEnabled ?? Boolean(config.token);
		this.config = {
			...config,
			paidEnabled,
			fxtwitterEnabled,
			provider:
				config.provider ??
				(fxtwitterEnabled ? "fxtwitter" : paidEnabled ? "6551" : "disabled"),
			restOnly: config.restOnly ?? fxtwitterEnabled,
			paidFallbackFailureThreshold:
				config.paidFallbackFailureThreshold ??
				DEFAULT_PAID_FALLBACK_FAILURE_THRESHOLD,
			paidFallbackCooldownMinutes:
				config.paidFallbackCooldownMinutes ??
				DEFAULT_PAID_FALLBACK_COOLDOWN_MINUTES,
			paidDailyRequestBudget:
				config.paidDailyRequestBudget ?? DEFAULT_PAID_DAILY_REQUEST_BUDGET,
		};
		this.client =
			client ??
			(this.config.paidEnabled
				? createBudgetedTwitter6551Client(this.config, {
						shouldSuppress: () =>
							this.stopped || localBridgeIsFresh(this.config),
					})
				: null);
		this.fxtwitter = fxtwitter;
	}

	private recoveryProvider() {
		if (this.config.fxtwitterEnabled) return "fxtwitter" as const;
		return "6551" as const;
	}

	private paidClient() {
		if (!this.client) {
			throw new Twitter6551Error("6551 paid recovery is disabled");
		}
		return this.client;
	}

	private isRestOnly() {
		return (
			this.recoveryProvider() === "fxtwitter" || Boolean(this.config.restOnly)
		);
	}

	private currentWatchUsers() {
		try {
			return mergeCloudCollectionHandles(
				getNativeDb({ seedDemoData: false }),
				this.config.watchUsers,
				cloudAllFollowingEnabled(),
			);
		} catch {
			return this.config.watchUsers;
		}
	}

	private handleFallbackAccountId(handle: string) {
		return `${this.config.accountId}:watch:${handle.toLowerCase()}`;
	}

	private handleRecoveryScope(handle: string) {
		return JSON.stringify({
			provider: "fxtwitter",
			accountId: this.config.accountId,
			watchUsers: [handle.toLowerCase()],
			targetTweetIds: [],
		});
	}

	private async resetSuccessfulFxHandles(handles: string[], now: Date) {
		for (const handle of handles) {
			await enqueueDatabaseWrite((db) =>
				recordTwitter6551FxRecovery(
					db,
					this.handleFallbackAccountId(handle),
					this.handleRecoveryScope(handle),
					"success",
					now,
				),
			);
		}
	}

	private async prepareTwillotFallbacks(handles: string[], now: Date) {
		const pending: string[] = [];
		const completed: string[] = [];
		const failed: string[] = [];
		const paidEligible: string[] = [];
		const twillotEnabled = twillotCloudFallbackEnabled();
		const timeoutMs = twillotFallbackTimeoutMinutes() * 60_000;
		for (const handle of handles) {
			const accountId = this.handleFallbackAccountId(handle);
			const scope = this.handleRecoveryScope(handle);
			const snapshot = await enqueueDatabaseWrite((db) => {
				const previous = readTwitter6551FallbackState(
					db,
					accountId,
					scope,
					now,
				);
				const target = findCloudFollowingTarget(db, handle);
				const twillotOutcome =
					twillotEnabled && target
						? evaluatePreviousTwillotFallback(db, {
								target,
								lastFxFailureAt: previous.lastCountedFxFailureAt,
								timeoutMs,
								now,
							})
						: ("failed" as const);
				const state = recordTwitter6551FxRecovery(
					db,
					accountId,
					scope,
					"total_failure",
					now,
					this.recoveryIntervalMs(),
				);
				const isNewFailure =
					state.lastCountedFxFailureAt !== previous.lastCountedFxFailureAt;
				if (twillotOutcome === "completed" && !isNewFailure) {
					return { outcome: "completed" as const, state };
				}
				if (
					twillotEnabled &&
					target &&
					(twillotOutcome === "none" || twillotOutcome === "completed")
				) {
					const job = queueTwillotFallback(db, { target, now });
					return {
						outcome: job ? ("pending" as const) : ("failed" as const),
						state,
					};
				}
				return { outcome: twillotOutcome, state };
			});
			if (snapshot.outcome === "pending") pending.push(handle);
			else if (snapshot.outcome === "completed") completed.push(handle);
			else {
				failed.push(handle);
				paidEligible.push(handle);
			}
		}
		return { pending, completed, failed, paidEligible };
	}

	async start(options: { forceBackfill?: boolean; allowPaid?: boolean } = {}) {
		if (!this.config.enabled || this.stopped) return;
		const watchUsers = this.currentWatchUsers();
		const previousRecovery = recoveryAttempts.get(
			this.recoveryScope(watchUsers),
		);
		assignRuntimeStatus({
			...emptyStatus(),
			enabled: true,
			provider: this.recoveryProvider(),
			state: "starting",
			activeSource: this.recoveryProvider(),
			watchUsers,
			lastBackfillAt: previousRecovery?.lastBackfillAt ?? null,
		});
		await enqueueDatabaseWrite((db) => {
			ensureTwitter6551Tables(db);
			ensureTwitter6551Account(
				db,
				this.config.accountId,
				this.recoveryProvider(),
			);
		});
		refreshPersistentTwitter6551Status(this.config);
		if (this.stopped) return;
		await this.replayPendingEvents();
		if (this.stopped) return;
		if (!this.isRestOnly()) await this.prepareWatches();
		if (this.stopped) return;
		const recoveryResult = options.forceBackfill
			? await this.runBackfill({ allowPaid: options.allowPaid })
			: await this.runBackfillIfDue();
		if (this.stopped) return;
		if (this.isRestOnly()) {
			if (recoveryResult === "skipped") {
				const previousAttempt = recoveryAttempts.get(this.recoveryScope());
				assignRuntimeStatus({
					...runtimeStatus,
					state:
						previousAttempt?.outcome === "failed"
							? "error"
							: previousAttempt?.outcome === "partial"
								? "degraded"
								: "polling",
					connected: false,
					lastError:
						previousAttempt?.outcome === "failed" ||
						previousAttempt?.outcome === "partial"
							? previousAttempt.error
							: null,
				});
			}
		} else {
			this.connect();
		}
		this.scheduleRecovery();
	}

	async stop() {
		this.stopped = true;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		if (this.backfillTimer) clearTimeout(this.backfillTimer);
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		if (this.subscriptionTimer) clearTimeout(this.subscriptionTimer);
		this.socket?.close(1000, "BirdClaw shutdown");
		this.socket = null;
		await this.drainInFlight();
		assignRuntimeStatus({
			...runtimeStatus,
			state: "stopped",
			connected: false,
		});
	}

	private track(promise: Promise<unknown>) {
		this.inFlight.add(promise);
		void promise
			.catch((error) => {
				assignRuntimeStatus({
					...runtimeStatus,
					state: "degraded",
					lastError: errorMessage(error),
				});
			})
			.finally(() => this.inFlight.delete(promise));
	}

	private async drainInFlight() {
		if (this.inFlight.size === 0) return;
		let timeout: ReturnType<typeof setTimeout> | null = null;
		await Promise.race([
			Promise.allSettled(this.inFlight),
			new Promise<void>((resolve) => {
				timeout = setTimeout(resolve, 10_000);
			}),
		]);
		if (timeout) clearTimeout(timeout);
	}

	private async fetchTwitter6551Tweets(
		watchUsers = this.currentWatchUsers(),
		targetTweetIds = this.config.targetTweetIds,
	) {
		const client = this.paidClient();
		const batches: Twitter6551Tweet[][] = [];
		const failures: string[] = [];
		let completedRequests = 0;
		let haltError: Error | null = null;
		let firstError: Error | null = null;
		const capture = async (
			label: string,
			request: () => Promise<Twitter6551Tweet[]>,
			ignoreStatuses: number[] = [],
		) => {
			if (this.stopped || localBridgeIsFresh(this.config)) {
				haltError = new Twitter6551PaidRequestSuppressedError(
					"6551 paid recovery was suppressed because the local BirdClaw bridge recovered",
				);
				return;
			}
			try {
				batches.push(await request());
				completedRequests += 1;
			} catch (error) {
				if (
					error instanceof Twitter6551PaidRequestSuppressedError ||
					error instanceof Twitter6551RequestBudgetError ||
					error instanceof Twitter6551RecoveryStateError
				) {
					haltError = error;
					return;
				}
				if (
					error instanceof Twitter6551Error &&
					error.status !== undefined &&
					ignoreStatuses.includes(error.status)
				) {
					completedRequests += 1;
					return;
				}
				failures.push(`${label}: ${errorMessage(error)}`);
				firstError ??=
					error instanceof Error ? error : new Twitter6551Error(String(error));
			}
		};
		for (const username of watchUsers) {
			await capture(`@${username}`, () => client.getUserTweets(username, 100));
			if (haltError) break;
		}
		for (const tweetId of targetTweetIds) {
			if (haltError) break;
			await capture(`status ${tweetId}`, async () => [
				await client.getTweet(tweetId),
			]);
			if (haltError) break;
			await capture(
				`conversation ${tweetId}`,
				() => client.searchTweets(`conversation_id:${tweetId}`, 100),
				[400, 403],
			);
			if (haltError) break;
			await capture(
				`quotes ${tweetId}`,
				() => client.getQuoteTweets(tweetId, 100),
				[403],
			);
		}
		return {
			tweets: [
				...new Map(batches.flat().map((tweet) => [tweet.id, tweet])).values(),
			],
			failures,
			completedRequests,
			haltError: haltError as Error | null,
			firstError: firstError as Error | null,
		};
	}

	private tweetsFromStatusEnvelope(envelope: FxTwitterStatusEnvelope) {
		const status = normalizeFxTwitterTweet(envelope.status);
		return [
			...(status ? [status] : []),
			...normalizeFxTwitterTweets(envelope.thread),
		];
	}

	private tweetsFromConversationEnvelope(
		envelope: FxTwitterConversationEnvelope,
	) {
		return [
			...this.tweetsFromStatusEnvelope(envelope),
			...normalizeFxTwitterTweets(envelope.replies),
		];
	}

	private tweetsFromSearchEnvelope(envelope: FxTwitterSearchEnvelope) {
		return normalizeFxTwitterTweets(envelope.results);
	}

	private async fetchFxTwitterTweets(watchUsers = this.currentWatchUsers()) {
		const batches: FxTwitterTweet[][] = [];
		const failures: string[] = [];
		const succeededWatchUsers: string[] = [];
		const failedWatchUsers: string[] = [];
		let completedRequests = 0;
		const capture = async <T>(
			label: string,
			request: () => Promise<T>,
			normalize: (value: T) => FxTwitterTweet[],
		) => {
			try {
				batches.push(normalize(await request()));
				completedRequests += 1;
			} catch (error) {
				failures.push(`${label}: ${errorMessage(error)}`);
			}
		};
		for (const username of watchUsers) {
			try {
				batches.push(
					this.tweetsFromSearchEnvelope(
						await this.fxtwitter.getProfileStatuses(username, {
							count: 100,
							withReplies: true,
						}),
					),
				);
				completedRequests += 1;
				succeededWatchUsers.push(username);
			} catch (error) {
				failedWatchUsers.push(username);
				failures.push(`@${username}: ${errorMessage(error)}`);
			}
		}
		for (const tweetId of this.config.targetTweetIds) {
			await capture(
				`status ${tweetId}`,
				() => this.fxtwitter.getStatus(tweetId),
				(value) => this.tweetsFromStatusEnvelope(value),
			);
			await capture(
				`conversation ${tweetId}`,
				() =>
					this.fxtwitter.getConversation(tweetId, {
						rankingMode: "recency",
					}),
				(value) => this.tweetsFromConversationEnvelope(value),
			);
			await capture(
				`quotes ${tweetId}`,
				() => this.fxtwitter.getQuotes(tweetId, { count: 100 }),
				(value) => this.tweetsFromSearchEnvelope(value),
			);
		}
		if (
			completedRequests === 0 &&
			failures.length > 0 &&
			(failedWatchUsers.length === 0 || !twillotCloudFallbackEnabled())
		) {
			throw new Twitter6551Error(
				`FxTwitter recovery failed: ${failures.join("; ")}`,
			);
		}
		return {
			tweets: [
				...new Map(batches.flat().map((tweet) => [tweet.id, tweet])).values(),
			],
			failures,
			succeededWatchUsers,
			failedWatchUsers,
		};
	}

	private async ingestFxTwitterTweets(tweets: FxTwitterTweet[]) {
		if (tweets.length === 0) return [];
		return enqueueDatabaseWrite((db) => {
			ensureTwitter6551Account(db, this.config.accountId, "fxtwitter");
			return ingestTweetPayload(db, {
				accountId: this.config.accountId,
				payload: fxTwitterTweetsToPayload(tweets),
				source: FXTWITTER_SOURCE,
				edgeKind: "home",
				markRepliesAsReplied: false,
				preserveExistingCanonical: true,
			});
		});
	}

	private async recordFxRecoveryOutcome(
		outcome: "success" | "partial" | "total_failure",
		options: { countFailure?: boolean } = {},
	) {
		if (outcome === "total_failure" && options.countFailure === false) {
			const state = readTwitter6551FallbackState(
				getNativeDb({ seedDemoData: false }),
				this.config.accountId,
				this.recoveryScope(),
			);
			applyFallbackStatus(state);
			return state;
		}
		const state = await enqueueDatabaseWrite((db) =>
			recordTwitter6551FxRecovery(
				db,
				this.config.accountId,
				this.recoveryScope(),
				outcome,
				new Date(),
				this.recoveryIntervalMs(),
			),
		);
		applyFallbackStatus(state);
		return state;
	}

	private ensurePaidBudgetAvailable() {
		try {
			const budget = readTwitter6551DailyBudget(
				getNativeDb({ seedDemoData: false }),
				this.config.paidDailyRequestBudget,
			);
			applyBudgetStatus(budget);
			if (budget.remaining === 0) {
				throw new Twitter6551RequestBudgetError(
					`6551 paid daily request budget exhausted (${String(budget.attempts)}/${String(budget.limit)} UTC ${budget.day}); requests are blocked`,
				);
			}
		} catch (error) {
			if (error instanceof Twitter6551RequestBudgetError) throw error;
			throw new Twitter6551RequestBudgetError(
				`6551 paid request budget could not be verified; requests are blocked (${errorMessage(error)})`,
			);
		}
	}

	private async runPaidFallbackForHandles(handles: string[], now: Date) {
		const ingested = new Set<string>();
		const recovered: string[] = [];
		const skipped: string[] = [];
		const failures: string[] = [];
		if (!this.config.paidEnabled || !this.client) {
			return {
				ingested: [] as string[],
				recovered,
				skipped: handles,
				failures: ["6551 paid reserve is disabled"],
			};
		}
		for (const handle of handles) {
			let claim: ReturnType<typeof claimTwitter6551PaidFallback>;
			try {
				claim = await enqueueDatabaseWrite((db) =>
					claimTwitter6551PaidFallback(
						db,
						this.handleFallbackAccountId(handle),
						this.handleRecoveryScope(handle),
						this.config.paidFallbackFailureThreshold,
						this.config.paidFallbackCooldownMinutes * 60_000,
						now,
					),
				);
			} catch (error) {
				failures.push(`@${handle}: ${errorMessage(error)}`);
				continue;
			}
			applyFallbackStatus(claim.state);
			if (!claim.claimed) {
				skipped.push(handle);
				continue;
			}
			try {
				this.ensurePaidBudgetAvailable();
				const tweets = await this.client.getUserTweets(handle, 100);
				const ids = await enqueueDatabaseWrite((db) =>
					ingestTwitter6551Tweets(
						db,
						this.config.accountId,
						tweets,
						"home",
						true,
					),
				);
				for (const id of ids) ingested.add(id);
				recovered.push(handle);
			} catch (error) {
				failures.push(`@${handle}: ${errorMessage(error)}`);
			}
		}
		return { ingested: [...ingested], recovered, skipped, failures };
	}

	private async runPaidFallback(
		fxError: unknown,
		fallbackState: ReturnType<typeof readTwitter6551FallbackState>,
		attemptedAt: number,
	) {
		if (!this.config.paidEnabled || !this.client) {
			throw new Twitter6551Error(
				`${errorMessage(fxError)}; 6551 paid reserve is disabled`,
			);
		}
		if (
			fallbackState.consecutiveFxTotalFailures <
			this.config.paidFallbackFailureThreshold
		) {
			throw new Twitter6551Error(
				`${errorMessage(fxError)}; paid reserve remains gated (${String(fallbackState.consecutiveFxTotalFailures)}/${String(this.config.paidFallbackFailureThreshold)} consecutive total failures)`,
			);
		}
		if (this.stopped || localBridgeIsFresh(this.config)) {
			throw new Twitter6551PaidRequestSuppressedError(
				"6551 paid recovery was suppressed because the local BirdClaw bridge recovered",
			);
		}
		this.ensurePaidBudgetAvailable();
		const claim = await enqueueDatabaseWrite((db) =>
			claimTwitter6551PaidFallback(
				db,
				this.config.accountId,
				this.recoveryScope(),
				this.config.paidFallbackFailureThreshold,
				this.config.paidFallbackCooldownMinutes * 60_000,
				new Date(),
			),
		);
		applyFallbackStatus(claim.state);
		if (!claim.claimed) {
			throw new Twitter6551Error(
				claim.reason === "cooldown"
					? `${errorMessage(fxError)}; 6551 paid reserve is cooling down`
					: `${errorMessage(fxError)}; 6551 paid reserve failure threshold is not met`,
			);
		}

		const paid = await this.fetchTwitter6551Tweets();
		const ingested = await enqueueDatabaseWrite((db) =>
			ingestTwitter6551Tweets(
				db,
				this.config.accountId,
				paid.tweets,
				"home",
				true,
			),
		);
		if (paid.completedRequests === 0) {
			if (paid.haltError) throw paid.haltError;
			if (paid.firstError) throw paid.firstError;
			throw new Twitter6551Error(
				paid.failures.length > 0
					? `6551 paid recovery failed: ${paid.failures.join("; ")}`
					: "6551 paid recovery returned no completed requests",
			);
		}
		const partial = paid.failures.length > 0 || Boolean(paid.haltError);
		const paidError = [
			...paid.failures,
			...(paid.haltError ? [paid.haltError.message] : []),
		];
		assignRuntimeStatus({
			...runtimeStatus,
			provider: "fxtwitter",
			activeSource: "6551",
			state: "degraded",
			connected: false,
			lastBackfillAt: new Date().toISOString(),
			lastError: partial
				? `6551 partial reserve recovery after FxTwitter total failure: ${paidError.slice(0, 3).join("; ")}`
				: "FxTwitter recovery failed; 6551 REST reserve completed",
			ingestedCount: runtimeStatus.ingestedCount + ingested.length,
		});
		recoveryAttempts.set(this.recoveryScope(), {
			attemptedAt,
			outcome: partial ? "partial" : "success",
			error: runtimeStatus.lastError,
			lastBackfillAt: runtimeStatus.lastBackfillAt,
		});
		return partial ? ("partial" as const) : ("success" as const);
	}

	async runBackfill(options: { allowPaid?: boolean } = {}) {
		if (this.backfillRunning || this.stopped) return "skipped" as const;
		const allowPaid = options.allowPaid ?? true;
		this.backfillRunning = true;
		const watchUsers = this.currentWatchUsers();
		const scope = this.recoveryScope(watchUsers);
		const attemptedAt = Date.now();
		assignRuntimeStatus({
			...runtimeStatus,
			watchUsers,
			cloudAllFollowing: cloudAllFollowingEnabled(),
			twillotCloudFallbackEnabled: twillotCloudFallbackEnabled(),
			twillotFallbackTimeoutMinutes: twillotFallbackTimeoutMinutes(),
		});
		recoveryAttempts.set(scope, {
			attemptedAt,
			outcome: "running",
			error: null,
			lastBackfillAt: runtimeStatus.lastBackfillAt,
		});
		try {
			const provider = this.recoveryProvider();
			let ingested: string[];
			let partialFailures: string[] = [];
			let activeSource: Twitter6551RuntimeStatus["activeSource"] = provider;
			let twillotPendingCount = 0;
			let twillotCompletedCount = 0;
			let twillotFailedCount = 0;
			if (provider === "fxtwitter") {
				let result: Awaited<ReturnType<typeof this.fetchFxTwitterTweets>>;
				try {
					result = await this.fetchFxTwitterTweets(watchUsers);
				} catch (error) {
					const fallbackState = await this.recordFxRecoveryOutcome(
						"total_failure",
						{ countFailure: allowPaid },
					);
					if (!allowPaid) throw error;
					return await this.runPaidFallback(error, fallbackState, attemptedAt);
				}
				partialFailures = result.failures;
				try {
					await this.recordFxRecoveryOutcome(
						partialFailures.length > 0 ? "partial" : "success",
					);
				} catch (error) {
					if (!(error instanceof Twitter6551RecoveryStateError)) throw error;
					partialFailures = [
						...partialFailures,
						`paid fallback state remains blocked: ${error.message}`,
					];
				}
				ingested = await this.ingestFxTwitterTweets(result.tweets);
				const now = new Date();
				if (twillotCloudFallbackEnabled()) {
					await this.resetSuccessfulFxHandles(result.succeededWatchUsers, now);
				}
				if (
					twillotCloudFallbackEnabled() &&
					result.failedWatchUsers.length > 0
				) {
					const fallbacks = await this.prepareTwillotFallbacks(
						result.failedWatchUsers,
						now,
					);
					twillotPendingCount = fallbacks.pending.length;
					twillotCompletedCount = fallbacks.completed.length;
					twillotFailedCount = fallbacks.failed.length;
					if (fallbacks.pending.length > 0) {
						activeSource = "twillot";
						partialFailures = [
							...partialFailures,
							`Twillot cloud fallback queued for ${String(fallbacks.pending.length)} account(s)`,
						];
					}
					if (fallbacks.paidEligible.length > 0) {
						if (allowPaid) {
							const paid = await this.runPaidFallbackForHandles(
								fallbacks.paidEligible,
								now,
							);
							ingested = [...new Set([...ingested, ...paid.ingested])];
							if (paid.recovered.length > 0) activeSource = "6551";
							partialFailures = [
								...partialFailures,
								...paid.failures.map((failure) => `6551 ${failure}`),
								...(paid.skipped.length > 0
									? [
											`6551 reserve remains gated for ${String(paid.skipped.length)} account(s)`,
										]
									: []),
							];
						} else {
							partialFailures = [
								...partialFailures,
								`6551 reserve is eligible for ${String(fallbacks.paidEligible.length)} account(s), but this manual run forbids paid requests`,
							];
						}
					}
				}
			} else {
				const paid = await this.fetchTwitter6551Tweets(watchUsers);
				if (paid.completedRequests === 0) {
					if (paid.haltError) throw paid.haltError;
					if (paid.firstError) throw paid.firstError;
					throw new Twitter6551Error(
						paid.failures.length > 0
							? `6551 recovery failed: ${paid.failures.join("; ")}`
							: "6551 recovery returned no completed requests",
					);
				}
				partialFailures = [
					...paid.failures,
					...(paid.haltError ? [paid.haltError.message] : []),
				];
				ingested = await enqueueDatabaseWrite((db) =>
					ingestTwitter6551Tweets(
						db,
						this.config.accountId,
						paid.tweets,
						"home",
						true,
					),
				);
			}
			assignRuntimeStatus({
				...runtimeStatus,
				provider,
				activeSource,
				watchUsers,
				twillotPendingCount,
				twillotCompletedCount,
				twillotFailedCount,
				state:
					partialFailures.length > 0
						? "degraded"
						: this.isRestOnly()
							? "polling"
							: runtimeStatus.connected && !this.watchUnavailable
								? "connected"
								: "degraded",
				lastBackfillAt: new Date().toISOString(),
				lastError:
					partialFailures.length > 0
						? `${provider === "fxtwitter" ? "FxTwitter" : "6551 REST"} partial recovery: ${partialFailures.slice(0, 3).join("; ")}${partialFailures.length > 3 ? `; and ${String(partialFailures.length - 3)} more` : ""}`
						: this.watchUnavailable
							? "6551 watch access is unavailable; REST recovery remains active"
							: null,
				ingestedCount: runtimeStatus.ingestedCount + ingested.length,
			});
			recoveryAttempts.set(scope, {
				attemptedAt,
				outcome: partialFailures.length > 0 ? "partial" : "success",
				error: runtimeStatus.lastError,
				lastBackfillAt: runtimeStatus.lastBackfillAt,
			});
			return partialFailures.length > 0
				? ("partial" as const)
				: ("success" as const);
		} catch (error) {
			assignRuntimeStatus({
				...runtimeStatus,
				state: runtimeStatus.connected ? "degraded" : "error",
				lastError: errorMessage(error),
			});
			recoveryAttempts.set(scope, {
				attemptedAt,
				outcome: "failed",
				error: runtimeStatus.lastError,
				lastBackfillAt: runtimeStatus.lastBackfillAt,
			});
			return "failed" as const;
		} finally {
			this.backfillRunning = false;
		}
	}

	private recoveryScope(watchUsers = this.currentWatchUsers()) {
		return recoveryScopeForConfig({ ...this.config, watchUsers });
	}

	private recoveryIntervalMs() {
		return this.config.backfillMinutes * 60_000;
	}

	private recoveryDelayMs(now = Date.now()) {
		const lastAttempt = recoveryAttempts.get(this.recoveryScope());
		if (!lastAttempt) return 0;
		return Math.max(
			0,
			lastAttempt.attemptedAt + this.recoveryIntervalMs() - now,
		);
	}

	private async runBackfillIfDue() {
		if (this.recoveryDelayMs() > 0) return "skipped" as const;
		return this.runBackfill();
	}

	private scheduleRecovery() {
		if (this.backfillTimer) clearTimeout(this.backfillTimer);
		if (this.stopped) return;
		const delay = Math.max(1, this.recoveryDelayMs());
		this.backfillTimer = setTimeout(() => {
			this.backfillTimer = null;
			this.track(this.runRecoveryCycle());
		}, delay);
		this.backfillTimer.unref?.();
	}

	private async runRecoveryCycle() {
		if (!this.isRestOnly()) await this.prepareWatches();
		await this.runBackfillIfDue();
		this.scheduleRecovery();
	}

	private async prepareWatches() {
		const client = this.paidClient();
		let unavailable = false;
		let lastError: string | null = null;
		for (const username of this.config.watchUsers) {
			try {
				await client.addWatch(username);
			} catch (error) {
				if (
					error instanceof Twitter6551Error &&
					(error.status === 400 || error.status === 403 || error.status === 409)
				) {
					if (error.status !== 403) continue;
					unavailable = true;
					lastError =
						"6551 watch access is unavailable on the current plan; REST recovery remains active";
					continue;
				}
				unavailable = true;
				lastError = `6551 watch preparation failed: ${errorMessage(error)}`;
			}
		}
		this.watchUnavailable = unavailable;
		if (lastError) {
			assignRuntimeStatus({
				...runtimeStatus,
				state: "degraded",
				lastError,
			});
		}
	}

	private connect() {
		if (this.stopped) return;
		assignRuntimeStatus({
			...runtimeStatus,
			state: "connecting",
			connected: false,
		});
		const socket = new WebSocket(
			websocketUrl(this.config.baseUrl, this.config.token),
		);
		this.socket = socket;
		socket.addEventListener("open", () => {
			if (this.socket !== socket || this.stopped) return;
			this.lastSocketActivityAt = Date.now();
			socket.send(
				JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "twitter.subscribe",
				}),
			);
			assignRuntimeStatus({
				...runtimeStatus,
				state: "connecting",
				connected: false,
			});
			if (this.subscriptionTimer) clearTimeout(this.subscriptionTimer);
			this.subscriptionTimer = setTimeout(() => {
				if (this.socket !== socket || this.stopped) return;
				assignRuntimeStatus({
					...runtimeStatus,
					state: "degraded",
					connected: false,
					lastError: "6551 realtime subscription timed out",
				});
				socket.close(4001, "subscription timeout");
			}, SUBSCRIPTION_TIMEOUT_MS);
		});
		socket.addEventListener("message", (event) => {
			if (this.socket !== socket || this.stopped) return;
			this.lastSocketActivityAt = Date.now();
			this.track(this.handleSocketMessage(event.data));
		});
		socket.addEventListener("error", () => {
			if (this.socket !== socket || this.stopped) return;
			assignRuntimeStatus({
				...runtimeStatus,
				state: "degraded",
				connected: false,
				lastError: "6551 realtime connection failed",
			});
		});
		socket.addEventListener("close", (event) => {
			if (this.socket !== socket) return;
			this.socket = null;
			if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
			if (this.subscriptionTimer) clearTimeout(this.subscriptionTimer);
			this.subscriptionTimer = null;
			assignRuntimeStatus({
				...runtimeStatus,
				state: this.stopped ? "stopped" : "degraded",
				connected: false,
			});
			if (!this.stopped) {
				this.scheduleReconnect(event.code === 1008);
			}
		});
	}

	private startHeartbeat(socket: WebSocket) {
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = setInterval(() => {
			if (this.socket !== socket || socket.readyState !== WebSocket.OPEN)
				return;
			if (Date.now() - this.lastSocketActivityAt > STALE_CONNECTION_MS) {
				socket.close(4000, "heartbeat timeout");
				return;
			}
			socket.send("ping");
		}, HEARTBEAT_MS);
	}

	private scheduleReconnect(authFailure: boolean) {
		if (this.reconnectTimer || this.stopped) return;
		const base = authFailure
			? AUTH_RECONNECT_MS
			: Math.min(
					MAX_RECONNECT_MS,
					1000 * 2 ** Math.min(this.reconnectAttempt, 6),
				);
		const delay = Math.floor(base * (0.85 + Math.random() * 0.3));
		this.reconnectAttempt += 1;
		assignRuntimeStatus({
			...runtimeStatus,
			reconnectCount: runtimeStatus.reconnectCount + 1,
		});
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, delay);
	}

	private async handleSocketMessage(raw: unknown) {
		let message: unknown = raw;
		if (typeof raw === "string") {
			if (raw === "ping") {
				this.socket?.send("pong");
				return;
			}
			if (raw === "pong") return;
			message = parseMaybeJson(raw);
		}
		const envelope = record(message);
		if (numberValue(envelope?.id) === 1) {
			const result = record(envelope?.result);
			const rpcError = record(envelope?.error);
			const subscribed = envelope?.result === true || result?.success === true;
			if (!subscribed || rpcError) {
				const detail =
					stringValue(rpcError?.message ?? result?.message) ??
					"subscription was rejected";
				if (this.subscriptionTimer) clearTimeout(this.subscriptionTimer);
				this.subscriptionTimer = null;
				assignRuntimeStatus({
					...runtimeStatus,
					state: "degraded",
					connected: false,
					lastError: `6551 realtime ${detail}`,
				});
				this.socket?.close(1008, "subscription rejected");
				return;
			}
			if (this.subscriptionTimer) clearTimeout(this.subscriptionTimer);
			this.subscriptionTimer = null;
			this.reconnectAttempt = 0;
			assignRuntimeStatus({
				...runtimeStatus,
				state: this.watchUnavailable ? "degraded" : "connected",
				connected: true,
				lastConnectedAt: new Date().toISOString(),
				lastError: this.watchUnavailable
					? "6551 watch access is unavailable; REST recovery remains active"
					: null,
			});
			this.startHeartbeat(this.socket as WebSocket);
			if (this.hasSubscribedOnce) this.track(this.runBackfill());
			this.hasSubscribedOnce = true;
			return;
		}
		if (envelope?.method !== "twitter.event") return;
		const params = record(envelope.params);
		if (!params) return;
		await this.persistAndProcessEvent(params);
	}

	private async persistAndProcessEvent(
		params: JsonRecord,
		options: { alreadyPersisted?: boolean } = {},
	) {
		const eventId =
			stringValue(params.id) ??
			`${Date.now().toString()}-${Math.random().toString(36).slice(2)}`;
		const eventType = stringValue(params.eventType) ?? "UNKNOWN";
		const watchUser = normalizedHandle(params.twAccount) ?? "";
		const content = record(parseMaybeJson(params.content));
		const tweet = normalizeTwitter6551Tweet(content, {
			screenName: watchUser,
			name: stringValue(params.twUserName) ?? watchUser,
		});
		const rawJson = JSON.stringify(params);
		const receivedAt = new Date().toISOString();
		if (!options.alreadyPersisted) {
			const inserted = await enqueueDatabaseWrite((db) => {
				ensureTwitter6551Tables(db);
				const result = db
					.prepare(
						`
						insert or ignore into twitter6551_events (
							event_id, event_type, watch_user, tweet_id, raw_json, received_at
						) values (?, ?, ?, ?, ?, ?)
						`,
					)
					.run(
						eventId,
						eventType,
						watchUser,
						tweet?.id ?? null,
						rawJson,
						receivedAt,
					);
				return result.changes > 0;
			});
			if (!inserted) return;
		}
		const allowedWatch = this.config.watchUsers.some(
			(username) => username.toLowerCase() === watchUser.toLowerCase(),
		);
		if (!allowedWatch) {
			await enqueueDatabaseWrite((db) => {
				db.prepare(
					"update twitter6551_events set processed_at = ?, error = ? where event_id = ?",
				).run(
					new Date().toISOString(),
					"ignored: watch user is not configured in BirdClaw",
					eventId,
				);
			});
			return;
		}
		const normalizedEventType = eventType.toUpperCase();
		const expectsTweet =
			normalizedEventType.includes("TWEET") ||
			normalizedEventType.includes("RETWEET") ||
			normalizedEventType.includes("REPLY") ||
			normalizedEventType.includes("QUOTE");
		if (expectsTweet && !tweet) {
			const message = "6551 tweet event could not be normalized";
			await enqueueDatabaseWrite((db) => {
				db.prepare(
					"update twitter6551_events set error = ? where event_id = ?",
				).run(message, eventId);
			});
			assignRuntimeStatus({
				...runtimeStatus,
				state: "degraded",
				lastError: message,
			});
			return;
		}
		try {
			const ids = tweet
				? await enqueueDatabaseWrite((db) =>
						ingestTwitter6551Tweets(db, this.config.accountId, [tweet], "home"),
					)
				: [];
			await enqueueDatabaseWrite((db) => {
				db.prepare(
					"update twitter6551_events set processed_at = ?, error = null where event_id = ?",
				).run(new Date().toISOString(), eventId);
			});
			assignRuntimeStatus({
				...runtimeStatus,
				lastEventAt: receivedAt,
				ingestedCount: runtimeStatus.ingestedCount + ids.length,
			});
		} catch (error) {
			await enqueueDatabaseWrite((db) => {
				db.prepare(
					"update twitter6551_events set error = ? where event_id = ?",
				).run(errorMessage(error), eventId);
			});
			assignRuntimeStatus({
				...runtimeStatus,
				state: "degraded",
				lastError: errorMessage(error),
			});
		}
	}

	private async replayPendingEvents() {
		let cursorReceivedAt = "";
		let cursorEventId = "";
		for (;;) {
			const rows = getNativeDb({ seedDemoData: false })
				.prepare(
					`
					select event_id, raw_json, received_at
					from twitter6551_events
					where processed_at is null
						and (received_at > ? or (received_at = ? and event_id > ?))
					order by received_at asc, event_id asc
					limit 1000
					`,
				)
				.all(cursorReceivedAt, cursorReceivedAt, cursorEventId) as Array<{
				event_id: string;
				raw_json: string;
				received_at: string;
			}>;
			if (rows.length === 0) return;
			for (const row of rows) {
				const params = record(parseMaybeJson(row.raw_json));
				if (params) {
					await this.persistAndProcessEvent(params, {
						alreadyPersisted: true,
					});
				}
				cursorReceivedAt = row.received_at;
				cursorEventId = row.event_id;
			}
		}
	}
}

export function getTwitter6551RuntimeStatus() {
	const shared = runtimeGlobal[RUNTIME_STATUS_KEY] as
		| Twitter6551RuntimeStatus
		| undefined;
	if (shared) runtimeStatus = shared;
	return { ...runtimeStatus };
}

function localBridgeIsFresh(
	config = getTwitter6551RuntimeConfig(),
	now = Date.now(),
) {
	return Boolean(
		config.failoverMode &&
		lastLocalHeartbeatAtMs &&
		now - lastLocalHeartbeatAtMs <= config.localStaleSeconds * 1000,
	);
}

export async function startTwitter6551Worker(
	options: { forceBackfill?: boolean; allowPaid?: boolean } = {},
) {
	const config = getTwitter6551RuntimeConfig();
	if (!config.enabled) {
		assignRuntimeStatus(emptyStatus());
		return null;
	}
	if (
		localBridgeIsFresh(config) &&
		!(options.forceBackfill && config.fxtwitterEnabled)
	) {
		assignRuntimeStatus({
			...runtimeStatus,
			...emptyStatus(),
			enabled: true,
			state: "standby",
			activeSource: "local",
			lastError: null,
		});
		refreshPersistentTwitter6551Status(config);
		return null;
	}
	if (activeWorker) return activeWorker;
	const worker = new Twitter6551Worker(config);
	activeWorker = worker;
	try {
		await worker.start(options);
	} catch (error) {
		activeWorker = null;
		assignRuntimeStatus({
			...runtimeStatus,
			state: "error",
			connected: false,
			lastError: errorMessage(error),
		});
		throw error;
	}
	return worker;
}

export async function stopTwitter6551Worker() {
	const worker = activeWorker;
	activeWorker = null;
	await worker?.stop();
}

let failoverTimer: ReturnType<typeof setInterval> | null = null;
let failoverStartedAtMs = 0;
let failoverReconcile: Promise<void> | null = null;

function recordTwitter6551FailoverError(error: unknown) {
	assignRuntimeStatus({
		...runtimeStatus,
		state: "error",
		connected: false,
		lastError: errorMessage(error),
	});
}

async function reconcileTwitter6551Failover() {
	if (failoverReconcile) return failoverReconcile;
	failoverReconcile = (async () => {
		const config = getTwitter6551RuntimeConfig();
		if (!config.enabled) {
			await stopTwitter6551Worker();
			assignRuntimeStatus(emptyStatus());
			return;
		}
		if (!config.failoverMode) {
			await startTwitter6551Worker();
			return;
		}
		const now = Date.now();
		if (localBridgeIsFresh(config, now)) {
			await stopTwitter6551Worker();
			assignRuntimeStatus({
				...runtimeStatus,
				enabled: true,
				provider: config.provider,
				state: "standby",
				connected: false,
				failoverMode: true,
				activeSource: "local",
				lastLocalHeartbeatAt: new Date(lastLocalHeartbeatAtMs).toISOString(),
				localStaleSeconds: config.localStaleSeconds,
				localBridgeIngestedCount,
				lastError: null,
			});
			refreshPersistentTwitter6551Status(config);
			return;
		}
		const graceElapsed =
			now - failoverStartedAtMs >= config.localStaleSeconds * 1000;
		if (!graceElapsed) {
			assignRuntimeStatus({
				...runtimeStatus,
				...emptyStatus(),
				enabled: true,
				state: "standby",
				activeSource: "waiting",
			});
			refreshPersistentTwitter6551Status(config);
			return;
		}
		await startTwitter6551Worker();
	})().finally(() => {
		failoverReconcile = null;
	});
	return failoverReconcile;
}

export async function startTwitter6551WorkerManager() {
	const config = getTwitter6551RuntimeConfig();
	if (!config.enabled || !config.failoverMode) {
		return startTwitter6551Worker();
	}
	if (!failoverStartedAtMs) failoverStartedAtMs = Date.now();
	if (!failoverTimer) {
		failoverTimer = setInterval(() => {
			void reconcileTwitter6551Failover().catch(recordTwitter6551FailoverError);
		}, FAILOVER_CHECK_MS);
	}
	await reconcileTwitter6551Failover();
	return activeWorker;
}

export async function recordTwitter6551LocalHeartbeat(
	ingestedEdges = 0,
	now = new Date(),
) {
	lastLocalHeartbeatAtMs = now.getTime();
	localBridgeIngestedCount += Math.max(0, ingestedEdges);
	assignRuntimeStatus({
		...runtimeStatus,
		lastLocalHeartbeatAt: now.toISOString(),
		localBridgeIngestedCount,
	});
	const config = getTwitter6551RuntimeConfig();
	if (config.fxtwitterEnabled) {
		try {
			const state = await enqueueDatabaseWrite((db) =>
				recordTwitter6551FxRecovery(
					db,
					config.accountId,
					recoveryScopeForConfig(config),
					"success",
					now,
				),
			);
			applyFallbackStatus(state);
		} catch (error) {
			assignRuntimeStatus({
				...runtimeStatus,
				lastError: `Local recovery is active, but the paid fallback state could not be reset (${errorMessage(error)})`,
			});
		}
	}
	await reconcileTwitter6551Failover();
	return getTwitter6551RuntimeStatus();
}

export async function stopTwitter6551WorkerManager() {
	if (failoverTimer) clearInterval(failoverTimer);
	failoverTimer = null;
	failoverStartedAtMs = 0;
	await stopTwitter6551Worker();
}

export async function runTwitter6551Backfill() {
	const config = getTwitter6551RuntimeConfig();
	if (localBridgeIsFresh(config) && !config.fxtwitterEnabled) {
		throw new Twitter6551Error(
			"Twitter recovery is standing by while the local BirdClaw bridge is online",
		);
	}
	if (!activeWorker) {
		const worker = await startTwitter6551Worker({
			forceBackfill: true,
			allowPaid: false,
		});
		if (!worker) throw new Twitter6551Error("Twitter recovery is disabled");
		return getTwitter6551RuntimeStatus();
	}
	await activeWorker.runBackfill({ allowPaid: false });
	return getTwitter6551RuntimeStatus();
}
