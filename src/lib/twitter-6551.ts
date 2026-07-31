import type { Database } from "./sqlite";
import { getTwitter6551Config } from "./config";
import { enqueueDatabaseWrite } from "./database-writer";
import { getNativeDb } from "./db";
import { ingestTweetPayload } from "./tweet-repository";
import type {
	XurlMedia,
	XurlMentionData,
	XurlMentionsResponse,
	XurlMentionUser,
} from "./types";

const SOURCE = "twitter6551";
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
	state:
		| "disabled"
		| "starting"
		| "connecting"
		| "connected"
		| "degraded"
		| "error"
		| "standby"
		| "stopped";
	connected: boolean;
	failoverMode: boolean;
	activeSource: "disabled" | "waiting" | "local" | "6551";
	watchUsers: string[];
	targetTweetIds: string[];
	lastConnectedAt: string | null;
	lastEventAt: string | null;
	lastBackfillAt: string | null;
	lastLocalHeartbeatAt: string | null;
	localStaleSeconds: number;
	localBridgeIngestedCount: number;
	lastError: string | null;
	reconnectCount: number;
	ingestedCount: number;
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
) {
	const now = new Date().toISOString();
	const handle =
		accountId === DEFAULT_ACCOUNT_ID
			? "@6551_watch"
			: `@${accountId.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40)}`;
	db.prepare(
		`
		insert into accounts (
			id, name, handle, external_user_id, transport, is_default, created_at
		) values (?, '6551 Watch', ?, null, 'twitter6551',
			case when exists(select 1 from accounts) then 0 else 1 end, ?)
		on conflict(id) do update set transport = excluded.transport
		`,
	).run(accountId, handle, now);
	return accountId;
}

export function ingestTwitter6551Tweets(
	db: Database,
	accountId: string,
	tweets: Twitter6551Tweet[],
	edgeKind: "home" | "profile" | "thread_context" = "home",
) {
	if (tweets.length === 0) return [];
	ensureTwitter6551Account(db, accountId);
	return ingestTweetPayload(db, {
		accountId,
		payload: twitter6551TweetsToPayload(tweets),
		source: SOURCE,
		edgeKind,
		markRepliesAsReplied: false,
	});
}

export interface Twitter6551ClientOptions {
	token: string;
	baseUrl?: string;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	sleep?: (ms: number) => Promise<void>;
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
				if (error instanceof Twitter6551Error) throw error;
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
	return {
		...base,
		token,
		enabled:
			process.env.BIRDCLAW_6551_ENABLED === "1" &&
			Boolean(token) &&
			(watchUsers.length > 0 || targetTweetIds.length > 0),
		accountId:
			process.env.BIRDCLAW_6551_ACCOUNT_ID?.trim() ||
			base.accountId ||
			DEFAULT_ACCOUNT_ID,
		watchUsers,
		targetTweetIds,
		backfillMinutes: positiveEnvNumber(
			"BIRDCLAW_6551_BACKFILL_MINUTES",
			base.backfillMinutes || DEFAULT_BACKFILL_MINUTES,
		),
		failoverMode: process.env.BIRDCLAW_6551_FAILOVER_MODE === "1",
		localStaleSeconds: positiveEnvNumber(
			"BIRDCLAW_LOCAL_STALE_SECONDS",
			DEFAULT_LOCAL_STALE_SECONDS,
		),
	};
}

let lastLocalHeartbeatAtMs = 0;
let localBridgeIngestedCount = 0;

function emptyStatus(): Twitter6551RuntimeStatus {
	const config = getTwitter6551RuntimeConfig();
	return {
		enabled: config.enabled,
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
				: "6551"
			: "disabled",
		watchUsers: config.watchUsers,
		targetTweetIds: config.targetTweetIds,
		lastConnectedAt: null,
		lastEventAt: null,
		lastBackfillAt: null,
		lastLocalHeartbeatAt: lastLocalHeartbeatAtMs
			? new Date(lastLocalHeartbeatAtMs).toISOString()
			: null,
		localStaleSeconds: config.localStaleSeconds,
		localBridgeIngestedCount,
		lastError: null,
		reconnectCount: 0,
		ingestedCount: 0,
	};
}

let runtimeStatus: Twitter6551RuntimeStatus = {
	enabled: false,
	state: "disabled",
	connected: false,
	failoverMode: false,
	activeSource: "disabled",
	watchUsers: [],
	targetTweetIds: [],
	lastConnectedAt: null,
	lastEventAt: null,
	lastBackfillAt: null,
	lastLocalHeartbeatAt: null,
	localStaleSeconds: DEFAULT_LOCAL_STALE_SECONDS,
	localBridgeIngestedCount: 0,
	lastError: null,
	reconnectCount: 0,
	ingestedCount: 0,
};
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

export class Twitter6551Worker {
	private socket: WebSocket | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private backfillTimer: ReturnType<typeof setInterval> | null = null;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private subscriptionTimer: ReturnType<typeof setTimeout> | null = null;
	private stopped = false;
	private lastSocketActivityAt = 0;
	private reconnectAttempt = 0;
	private backfillRunning = false;
	private watchUnavailable = false;
	private hasSubscribedOnce = false;
	private readonly inFlight = new Set<Promise<void>>();

	constructor(
		private readonly config = getTwitter6551RuntimeConfig(),
		private readonly client = new Twitter6551Client({
			token: config.token,
			baseUrl: config.baseUrl,
		}),
	) {}

	async start() {
		if (!this.config.enabled || this.stopped) return;
		runtimeStatus = {
			...emptyStatus(),
			enabled: true,
			state: "starting",
			activeSource: "6551",
		};
		await enqueueDatabaseWrite((db) => {
			ensureTwitter6551Tables(db);
			ensureTwitter6551Account(db, this.config.accountId);
		});
		if (this.stopped) return;
		await this.replayPendingEvents();
		if (this.stopped) return;
		await this.prepareWatches();
		if (this.stopped) return;
		await this.runBackfill();
		if (this.stopped) return;
		this.connect();
		this.backfillTimer = setInterval(
			() => this.track(this.runRecoveryCycle()),
			this.config.backfillMinutes * 60_000,
		);
	}

	async stop() {
		this.stopped = true;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		if (this.backfillTimer) clearInterval(this.backfillTimer);
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		if (this.subscriptionTimer) clearTimeout(this.subscriptionTimer);
		this.socket?.close(1000, "BirdClaw shutdown");
		this.socket = null;
		await this.drainInFlight();
		runtimeStatus = {
			...runtimeStatus,
			state: "stopped",
			connected: false,
		};
	}

	private track(promise: Promise<void>) {
		this.inFlight.add(promise);
		void promise
			.catch((error) => {
				runtimeStatus = {
					...runtimeStatus,
					state: "degraded",
					lastError: errorMessage(error),
				};
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

	async runBackfill() {
		if (this.backfillRunning || this.stopped) return;
		this.backfillRunning = true;
		try {
			const batches: Twitter6551Tweet[][] = [];
			for (const username of this.config.watchUsers) {
				batches.push(await this.client.getUserTweets(username, 100));
			}
			for (const tweetId of this.config.targetTweetIds) {
				const target = await this.client.getTweet(tweetId);
				batches.push([target]);
				try {
					batches.push(
						await this.client.searchTweets(`conversation_id:${tweetId}`, 100),
					);
				} catch (error) {
					if (
						!(
							error instanceof Twitter6551Error &&
							(error.status === 400 || error.status === 403)
						)
					) {
						throw error;
					}
				}
				try {
					batches.push(await this.client.getQuoteTweets(tweetId, 100));
				} catch (error) {
					if (!(error instanceof Twitter6551Error && error.status === 403)) {
						throw error;
					}
				}
			}
			const tweets = [
				...new Map(batches.flat().map((tweet) => [tweet.id, tweet])).values(),
			];
			const ingested = await enqueueDatabaseWrite((db) =>
				ingestTwitter6551Tweets(db, this.config.accountId, tweets, "home"),
			);
			runtimeStatus = {
				...runtimeStatus,
				state:
					runtimeStatus.connected && !this.watchUnavailable
						? "connected"
						: "degraded",
				lastBackfillAt: new Date().toISOString(),
				lastError: this.watchUnavailable
					? "6551 watch access is unavailable; REST recovery remains active"
					: null,
				ingestedCount: runtimeStatus.ingestedCount + ingested.length,
			};
		} catch (error) {
			runtimeStatus = {
				...runtimeStatus,
				state: runtimeStatus.connected ? "degraded" : "error",
				lastError: errorMessage(error),
			};
		} finally {
			this.backfillRunning = false;
		}
	}

	private async runRecoveryCycle() {
		await this.prepareWatches();
		await this.runBackfill();
	}

	private async prepareWatches() {
		let unavailable = false;
		let lastError: string | null = null;
		for (const username of this.config.watchUsers) {
			try {
				await this.client.addWatch(username);
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
			runtimeStatus = {
				...runtimeStatus,
				state: "degraded",
				lastError,
			};
		}
	}

	private connect() {
		if (this.stopped) return;
		runtimeStatus = { ...runtimeStatus, state: "connecting", connected: false };
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
			runtimeStatus = {
				...runtimeStatus,
				state: "connecting",
				connected: false,
			};
			if (this.subscriptionTimer) clearTimeout(this.subscriptionTimer);
			this.subscriptionTimer = setTimeout(() => {
				if (this.socket !== socket || this.stopped) return;
				runtimeStatus = {
					...runtimeStatus,
					state: "degraded",
					connected: false,
					lastError: "6551 realtime subscription timed out",
				};
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
			runtimeStatus = {
				...runtimeStatus,
				state: "degraded",
				connected: false,
				lastError: "6551 realtime connection failed",
			};
		});
		socket.addEventListener("close", (event) => {
			if (this.socket !== socket) return;
			this.socket = null;
			if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
			if (this.subscriptionTimer) clearTimeout(this.subscriptionTimer);
			this.subscriptionTimer = null;
			runtimeStatus = {
				...runtimeStatus,
				state: this.stopped ? "stopped" : "degraded",
				connected: false,
			};
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
		runtimeStatus = {
			...runtimeStatus,
			reconnectCount: runtimeStatus.reconnectCount + 1,
		};
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
				runtimeStatus = {
					...runtimeStatus,
					state: "degraded",
					connected: false,
					lastError: `6551 realtime ${detail}`,
				};
				this.socket?.close(1008, "subscription rejected");
				return;
			}
			if (this.subscriptionTimer) clearTimeout(this.subscriptionTimer);
			this.subscriptionTimer = null;
			this.reconnectAttempt = 0;
			runtimeStatus = {
				...runtimeStatus,
				state: this.watchUnavailable ? "degraded" : "connected",
				connected: true,
				lastConnectedAt: new Date().toISOString(),
				lastError: this.watchUnavailable
					? "6551 watch access is unavailable; REST recovery remains active"
					: null,
			};
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
			runtimeStatus = {
				...runtimeStatus,
				state: "degraded",
				lastError: message,
			};
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
			runtimeStatus = {
				...runtimeStatus,
				lastEventAt: receivedAt,
				ingestedCount: runtimeStatus.ingestedCount + ids.length,
			};
		} catch (error) {
			await enqueueDatabaseWrite((db) => {
				db.prepare(
					"update twitter6551_events set error = ? where event_id = ?",
				).run(errorMessage(error), eventId);
			});
			runtimeStatus = {
				...runtimeStatus,
				state: "degraded",
				lastError: errorMessage(error),
			};
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

export async function startTwitter6551Worker() {
	const config = getTwitter6551RuntimeConfig();
	if (!config.enabled) {
		runtimeStatus = emptyStatus();
		return null;
	}
	if (localBridgeIsFresh(config)) {
		runtimeStatus = {
			...runtimeStatus,
			...emptyStatus(),
			enabled: true,
			state: "standby",
			activeSource: "local",
			lastError: null,
		};
		return null;
	}
	if (activeWorker) return activeWorker;
	const worker = new Twitter6551Worker(config);
	activeWorker = worker;
	try {
		await worker.start();
	} catch (error) {
		activeWorker = null;
		runtimeStatus = {
			...runtimeStatus,
			state: "error",
			connected: false,
			lastError: errorMessage(error),
		};
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
	runtimeStatus = {
		...runtimeStatus,
		state: "error",
		connected: false,
		lastError: errorMessage(error),
	};
}

async function reconcileTwitter6551Failover() {
	if (failoverReconcile) return failoverReconcile;
	failoverReconcile = (async () => {
		const config = getTwitter6551RuntimeConfig();
		if (!config.enabled) {
			await stopTwitter6551Worker();
			runtimeStatus = emptyStatus();
			return;
		}
		if (!config.failoverMode) {
			await startTwitter6551Worker();
			return;
		}
		const now = Date.now();
		if (localBridgeIsFresh(config, now)) {
			await stopTwitter6551Worker();
			runtimeStatus = {
				...runtimeStatus,
				enabled: true,
				state: "standby",
				connected: false,
				failoverMode: true,
				activeSource: "local",
				lastLocalHeartbeatAt: new Date(lastLocalHeartbeatAtMs).toISOString(),
				localStaleSeconds: config.localStaleSeconds,
				localBridgeIngestedCount,
				lastError: null,
			};
			return;
		}
		const graceElapsed =
			now - failoverStartedAtMs >= config.localStaleSeconds * 1000;
		if (!graceElapsed) {
			runtimeStatus = {
				...runtimeStatus,
				...emptyStatus(),
				enabled: true,
				state: "standby",
				activeSource: "waiting",
			};
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
	runtimeStatus = {
		...runtimeStatus,
		lastLocalHeartbeatAt: now.toISOString(),
		localBridgeIngestedCount,
	};
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
	if (localBridgeIsFresh()) {
		throw new Twitter6551Error(
			"6551 is standing by while the local BirdClaw bridge is online",
		);
	}
	if (!activeWorker) {
		const worker = await startTwitter6551Worker();
		if (!worker) throw new Twitter6551Error("6551 worker is disabled");
	}
	await activeWorker?.runBackfill();
	return getTwitter6551RuntimeStatus();
}
