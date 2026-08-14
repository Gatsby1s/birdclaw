import type {
	XurlMedia,
	XurlMentionData,
	XurlMentionsResponse,
	XurlMentionUser,
} from "./types";

export const FXTWITTER_BASE_URL = "https://api.fxtwitter.com";
export const FXTWITTER_USER_AGENT =
	"BirdClaw/0.8 FxTwitterClient (+https://github.com/Gatsby1s/birdclaw)";
export const FXTWITTER_REQUEST_TIMEOUT_MS = 30_000;
export const FXTWITTER_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

const DEFAULT_MAX_RETRIES = 2;
const MAX_CONFIGURABLE_RETRIES = 5;

type JsonRecord = Record<string, unknown>;

export interface FxTwitterCursor {
	top?: string | null;
	bottom?: string | null;
}

export interface FxTwitterStatusEnvelope {
	code: number;
	status: JsonRecord | null;
	thread: JsonRecord[] | null;
	author?: JsonRecord | null;
}

export interface FxTwitterConversationEnvelope extends FxTwitterStatusEnvelope {
	replies: JsonRecord[] | null;
	cursor: FxTwitterCursor | null;
}

export interface FxTwitterSearchEnvelope {
	code: number;
	results: JsonRecord[];
	cursor: FxTwitterCursor | null;
}

export interface FxTwitterClientOptions {
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	maxRetries?: number;
	maxResponseBytes?: number;
	sleep?: (ms: number) => Promise<void>;
}

export interface FxTwitterStatusOptions {
	aboutAccount?: boolean;
	lang?: string;
}

export interface FxTwitterProfileStatusesOptions {
	count?: number;
	cursor?: string;
	since?: number;
	withReplies?: boolean;
	groupThreads?: boolean;
	lang?: string;
}

export interface FxTwitterConversationOptions extends FxTwitterStatusOptions {
	rankingMode?: "likes" | "recency";
	cursor?: string;
}

export interface FxTwitterQuotesOptions {
	count?: number;
	cursor?: string;
	lang?: string;
}

export class FxTwitterError extends Error {
	constructor(
		message: string,
		public readonly status?: number,
		public readonly code?: number,
		public readonly retryable = false,
	) {
		super(message);
		this.name = "FxTwitterError";
	}
}

export interface FxTwitterUserMetrics {
	followers?: number;
	following?: number;
	statuses?: number;
	media?: number;
	likes?: number;
}

export interface FxTwitterUser {
	id: string;
	name: string;
	screenName: string;
	description?: string;
	avatarUrl?: string;
	bannerUrl?: string;
	verified?: boolean;
	metrics: FxTwitterUserMetrics;
}

export interface FxTwitterTweetMetrics {
	likes: number;
	reposts: number;
	quotes: number;
	replies: number;
	views?: number;
	bookmarks?: number;
}

export interface FxTwitterMedia {
	type: string;
	url: string;
	thumbnailUrl?: string;
	width?: number;
	height?: number;
	durationSeconds?: number;
	altText?: string;
	variants: Array<{
		url: string;
		contentType?: string;
		bitRate?: number;
	}>;
}

export interface FxTwitterFacet {
	type: "url" | "mention" | "hashtag";
	start: number;
	end: number;
	original?: string;
	replacement?: string;
	display?: string;
	id?: string;
}

export interface FxTwitterReplyReference {
	id: string;
	screenName: string;
	url?: string;
	profileUrl?: string;
	displayName?: string;
}

export interface FxTwitterTombstone {
	kind: "tombstone";
	id?: string;
	reason: string;
	message: string;
	url?: string;
}

export interface FxTwitterTweet {
	kind: "tweet";
	id: string;
	url?: string;
	text: string;
	createdAt: string;
	lang?: string;
	user: FxTwitterUser;
	metrics: FxTwitterTweetMetrics;
	conversationId?: string;
	reply?: FxTwitterReplyReference;
	quote?: FxTwitterTweet | FxTwitterTombstone;
	media: FxTwitterMedia[];
	facets: FxTwitterFacet[];
	raw: JsonRecord;
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
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function booleanValue(value: unknown) {
	return typeof value === "boolean" ? value : undefined;
}

function records(value: unknown) {
	return Array.isArray(value)
		? value.map(record).filter((item): item is JsonRecord => item !== null)
		: [];
}

function hasOwn(source: JsonRecord, key: string) {
	return Object.prototype.hasOwnProperty.call(source, key);
}

function invalidEnvelope(endpoint: string, field: string) {
	return new FxTwitterError(
		`FxTwitter ${endpoint} response has an invalid ${field} field`,
		200,
		200,
	);
}

function nullableRecordField(
	source: JsonRecord,
	key: string,
	endpoint: string,
) {
	if (!hasOwn(source, key)) throw invalidEnvelope(endpoint, key);
	if (source[key] === null) return null;
	const normalized = record(source[key]);
	if (!normalized) throw invalidEnvelope(endpoint, key);
	return normalized;
}

function nullableRecordsField(
	source: JsonRecord,
	key: string,
	endpoint: string,
) {
	if (!hasOwn(source, key)) throw invalidEnvelope(endpoint, key);
	if (source[key] === null) return null;
	if (!Array.isArray(source[key])) throw invalidEnvelope(endpoint, key);
	const normalized = records(source[key]);
	if (normalized.length !== source[key].length) {
		throw invalidEnvelope(endpoint, key);
	}
	return normalized;
}

function cursorField(source: JsonRecord, endpoint: string) {
	const cursor = nullableRecordField(source, "cursor", endpoint);
	if (!cursor) return null;
	for (const key of ["top", "bottom"] as const) {
		if (
			hasOwn(cursor, key) &&
			cursor[key] !== null &&
			typeof cursor[key] !== "string"
		) {
			throw invalidEnvelope(endpoint, `cursor.${key}`);
		}
	}
	return {
		...(hasOwn(cursor, "top")
			? { top: (cursor.top as string | null) ?? null }
			: {}),
		...(hasOwn(cursor, "bottom")
			? { bottom: (cursor.bottom as string | null) ?? null }
			: {}),
	};
}

function statusEnvelope(
	source: JsonRecord,
	endpoint: string,
): FxTwitterStatusEnvelope {
	const author = hasOwn(source, "author")
		? nullableRecordField(source, "author", endpoint)
		: undefined;
	return {
		code: numberValue(source.code)!,
		status: nullableRecordField(source, "status", endpoint),
		thread: nullableRecordsField(source, "thread", endpoint),
		...(author !== undefined ? { author } : {}),
	};
}

function conversationEnvelope(
	source: JsonRecord,
): FxTwitterConversationEnvelope {
	return {
		...statusEnvelope(source, "conversation"),
		replies: nullableRecordsField(source, "replies", "conversation"),
		cursor: cursorField(source, "conversation"),
	};
}

function searchEnvelope(
	source: JsonRecord,
	endpoint: string,
): FxTwitterSearchEnvelope {
	const results = nullableRecordsField(source, "results", endpoint);
	if (!results) throw invalidEnvelope(endpoint, "results");
	return {
		code: numberValue(source.code)!,
		results,
		cursor: cursorField(source, endpoint),
	};
}

function queryString(
	values: Record<string, string | number | boolean | undefined>,
) {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(values)) {
		if (value !== undefined && String(value).trim()) {
			params.set(key, String(value));
		}
	}
	const encoded = params.toString();
	return encoded ? `?${encoded}` : "";
}

function pathSegment(value: string, label: string) {
	const normalized = value.trim();
	if (!normalized) throw new FxTwitterError(`${label} is required`);
	return encodeURIComponent(normalized);
}

function isRetryableStatus(status: number) {
	return status === 408 || status === 425 || status === 429 || status >= 500;
}

function errorMessage(payload: JsonRecord | null, status: number) {
	return (
		stringValue(payload?.message) ??
		stringValue(payload?.error) ??
		stringValue(payload?.detail) ??
		`FxTwitter request failed with code ${String(status)}`
	);
}

function retryDelayMs(attempt: number, response?: Response) {
	const retryAfter = response?.headers.get("retry-after")?.trim();
	if (retryAfter) {
		const seconds = Number(retryAfter);
		if (Number.isFinite(seconds) && seconds >= 0) {
			return Math.min(seconds * 1_000, 30_000);
		}
	}
	return Math.min(500 * 2 ** attempt, 4_000);
}

async function defaultSleep(ms: number) {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function bestEffortCancel(cancel: () => Promise<void>) {
	try {
		await cancel();
	} catch {
		// Keep the deterministic response-size error if transport cleanup fails.
	}
}

async function readResponseText(response: Response, maxBytes: number) {
	const declaredLength = numberValue(response.headers.get("content-length"));
	if (declaredLength !== undefined && declaredLength > maxBytes) {
		if (response.body) {
			await bestEffortCancel(() => response.body!.cancel());
		}
		throw new FxTwitterError(
			`FxTwitter response exceeds ${String(maxBytes)} bytes`,
			response.status,
		);
	}
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let totalBytes = 0;
	let text = "";
	while (true) {
		const chunk = await reader.read();
		if (chunk.done) break;
		totalBytes += chunk.value.byteLength;
		if (totalBytes > maxBytes) {
			await bestEffortCancel(() => reader.cancel());
			throw new FxTwitterError(
				`FxTwitter response exceeds ${String(maxBytes)} bytes`,
				response.status,
			);
		}
		text += decoder.decode(chunk.value, { stream: true });
	}
	return text + decoder.decode();
}

export class FxTwitterClient {
	private readonly fetchImpl: typeof fetch;
	private readonly timeoutMs: number;
	private readonly maxRetries: number;
	private readonly maxResponseBytes: number;
	private readonly sleep: (ms: number) => Promise<void>;

	constructor(options: FxTwitterClientOptions = {}) {
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.timeoutMs =
			options.timeoutMs !== undefined &&
			Number.isFinite(options.timeoutMs) &&
			options.timeoutMs > 0
				? options.timeoutMs
				: FXTWITTER_REQUEST_TIMEOUT_MS;
		this.maxRetries = Number.isFinite(options.maxRetries)
			? Math.min(
					Math.max(0, Math.trunc(options.maxRetries!)),
					MAX_CONFIGURABLE_RETRIES,
				)
			: DEFAULT_MAX_RETRIES;
		this.maxResponseBytes =
			options.maxResponseBytes !== undefined &&
			Number.isFinite(options.maxResponseBytes) &&
			options.maxResponseBytes > 0
				? Math.trunc(options.maxResponseBytes)
				: FXTWITTER_MAX_RESPONSE_BYTES;
		this.sleep = options.sleep ?? defaultSleep;
	}

	async getStatus(
		id: string,
		options: FxTwitterStatusOptions = {},
	): Promise<FxTwitterStatusEnvelope> {
		const payload = await this.request(
			`/2/status/${pathSegment(id, "status id")}${queryString({
				about_account: options.aboutAccount,
				lang: options.lang,
			})}`,
		);
		return statusEnvelope(payload!, "status");
	}

	async getProfileStatuses(
		handle: string,
		options: FxTwitterProfileStatusesOptions = {},
	): Promise<FxTwitterSearchEnvelope> {
		const result = await this.request(
			`/2/profile/${pathSegment(handle, "profile handle")}/statuses${queryString(
				{
					count: options.count,
					cursor: options.cursor,
					since: options.since,
					with_replies: options.withReplies,
					groupthreads: options.groupThreads,
					lang: options.lang,
				},
			)}`,
			true,
		);
		return result
			? searchEnvelope(result, "profile statuses")
			: { code: 204, results: [], cursor: null };
	}

	async getConversation(
		id: string,
		options: FxTwitterConversationOptions = {},
	): Promise<FxTwitterConversationEnvelope> {
		const payload = await this.request(
			`/2/conversation/${pathSegment(id, "conversation id")}${queryString({
				ranking_mode: options.rankingMode,
				cursor: options.cursor,
				about_account: options.aboutAccount,
				lang: options.lang,
			})}`,
		);
		return conversationEnvelope(payload!);
	}

	async getQuotes(
		id: string,
		options: FxTwitterQuotesOptions = {},
	): Promise<FxTwitterSearchEnvelope> {
		const payload = await this.request(
			`/2/status/${pathSegment(id, "status id")}/quotes${queryString({
				count: options.count,
				cursor: options.cursor,
				lang: options.lang,
			})}`,
		);
		return searchEnvelope(payload!, "quotes");
	}

	private async request(path: string, allowNoContent = false) {
		const url = new URL(path, FXTWITTER_BASE_URL);
		for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
			let response: Response | undefined;
			try {
				response = await this.fetchImpl(url, {
					method: "GET",
					headers: {
						accept: "application/json",
						"user-agent": FXTWITTER_USER_AGENT,
					},
					signal: controller.signal,
				});
				if (response.status === 204 && allowNoContent) return undefined;
				const text = await readResponseText(response, this.maxResponseBytes);
				let payload: JsonRecord | null = null;
				try {
					payload = record(JSON.parse(text));
				} catch {
					payload = null;
				}
				const code = numberValue(payload?.code);
				if (code === undefined) {
					throw new FxTwitterError(
						"FxTwitter response is missing a numeric code field",
						response.status,
						undefined,
						isRetryableStatus(response.status),
					);
				}
				payload!.code = code;
				const successfulCode = code >= 200 && code < 300;
				if (!response.ok || !successfulCode) {
					const status = successfulCode ? response.status : code;
					throw new FxTwitterError(
						errorMessage(payload, status),
						response.status,
						code,
						isRetryableStatus(status) || isRetryableStatus(response.status),
					);
				}
				return payload!;
			} catch (error) {
				const normalized =
					error instanceof FxTwitterError
						? error
						: new FxTwitterError(
								controller.signal.aborted
									? `FxTwitter request timed out after ${String(this.timeoutMs)}ms`
									: `FxTwitter request failed: ${error instanceof Error ? error.message : String(error)}`,
								undefined,
								undefined,
								true,
							);
				if (!normalized.retryable || attempt >= this.maxRetries)
					throw normalized;
				await this.sleep(retryDelayMs(attempt, response));
			} finally {
				clearTimeout(timeout);
			}
		}
		throw new FxTwitterError("FxTwitter request failed");
	}
}

export function normalizeFxTwitterUser(value: unknown): FxTwitterUser | null {
	const source = record(value);
	if (!source) return null;
	const id = stringValue(source.id);
	const screenName = stringValue(source.screen_name)?.replace(/^@/, "");
	if (!id || !screenName) return null;
	const verification = record(source.verification);
	return {
		id,
		name: stringValue(source.name) ?? screenName,
		screenName,
		...(stringValue(source.description)
			? { description: stringValue(source.description) }
			: {}),
		...(stringValue(source.avatar_url)
			? { avatarUrl: stringValue(source.avatar_url) }
			: {}),
		...(stringValue(source.banner_url)
			? { bannerUrl: stringValue(source.banner_url) }
			: {}),
		...(booleanValue(verification?.verified) !== undefined
			? { verified: booleanValue(verification?.verified) }
			: {}),
		metrics: {
			...(numberValue(source.followers) !== undefined
				? { followers: numberValue(source.followers) }
				: {}),
			...(numberValue(source.following) !== undefined
				? { following: numberValue(source.following) }
				: {}),
			...(numberValue(source.statuses) !== undefined
				? { statuses: numberValue(source.statuses) }
				: {}),
			...(numberValue(source.media_count) !== undefined
				? { media: numberValue(source.media_count) }
				: {}),
			...(numberValue(source.likes) !== undefined
				? { likes: numberValue(source.likes) }
				: {}),
		},
	};
}

function normalizeCreatedAt(source: JsonRecord) {
	const createdAt = stringValue(source.created_at);
	if (createdAt) {
		const timestamp = new Date(createdAt);
		return Number.isFinite(timestamp.getTime())
			? timestamp.toISOString()
			: createdAt;
	}
	const createdTimestamp = numberValue(source.created_timestamp);
	if (createdTimestamp !== undefined) {
		return new Date(createdTimestamp * 1_000).toISOString();
	}
	return "";
}

function normalizeFacets(rawText: JsonRecord | null): FxTwitterFacet[] {
	return records(rawText?.facets).flatMap((facet) => {
		const type = stringValue(facet.type);
		const indices = Array.isArray(facet.indices) ? facet.indices : [];
		const start = numberValue(indices[0]);
		const end = numberValue(indices[1]);
		if (
			(type !== "url" && type !== "mention" && type !== "hashtag") ||
			start === undefined ||
			end === undefined
		) {
			return [];
		}
		return [
			{
				type,
				start,
				end,
				...(stringValue(facet.original)
					? { original: stringValue(facet.original) }
					: {}),
				...(stringValue(facet.replacement)
					? { replacement: stringValue(facet.replacement) }
					: {}),
				...(stringValue(facet.display)
					? { display: stringValue(facet.display) }
					: {}),
				...(stringValue(facet.id) ? { id: stringValue(facet.id) } : {}),
			},
		];
	});
}

function normalizeMediaItem(value: unknown): FxTwitterMedia | null {
	const source = record(value);
	if (!source) return null;
	const type = stringValue(source.type);
	const url = stringValue(source.url);
	if (!type || !url) return null;
	return {
		type,
		url,
		...(stringValue(source.thumbnail_url)
			? { thumbnailUrl: stringValue(source.thumbnail_url) }
			: {}),
		...(numberValue(source.width) !== undefined
			? { width: numberValue(source.width) }
			: {}),
		...(numberValue(source.height) !== undefined
			? { height: numberValue(source.height) }
			: {}),
		...(numberValue(source.duration) !== undefined
			? { durationSeconds: numberValue(source.duration) }
			: {}),
		...(stringValue(source.altText)
			? { altText: stringValue(source.altText) }
			: {}),
		variants: records(source.formats).flatMap((format) => {
			const variantUrl = stringValue(format.url);
			if (!variantUrl) return [];
			const container = stringValue(format.container);
			const contentType =
				container === "m3u8"
					? "application/x-mpegURL"
					: container
						? `video/${container}`
						: undefined;
			return [
				{
					url: variantUrl,
					...(contentType ? { contentType } : {}),
					...(numberValue(format.bitrate) !== undefined
						? { bitRate: numberValue(format.bitrate) }
						: {}),
				},
			];
		}),
	};
}

function normalizeMedia(value: unknown) {
	const source = record(value);
	if (!source) return [];
	const all = records(source.all);
	const candidates =
		all.length > 0
			? all
			: [
					...records(source.photos),
					...records(source.videos),
					...(record(source.external) ? [record(source.external)!] : []),
				];
	return candidates
		.map(normalizeMediaItem)
		.filter((item): item is FxTwitterMedia => item !== null);
}

function normalizeTombstone(value: JsonRecord): FxTwitterTombstone {
	return {
		kind: "tombstone",
		...(stringValue(value.id) ? { id: stringValue(value.id) } : {}),
		reason: stringValue(value.reason) ?? "unavailable",
		message: stringValue(value.message) ?? "Post unavailable",
		...(stringValue(value.url) ? { url: stringValue(value.url) } : {}),
	};
}

export function normalizeFxTwitterTweet(value: unknown): FxTwitterTweet | null {
	const source = record(value);
	if (
		!source ||
		source.type === "tombstone" ||
		(source.reposted_by !== undefined && source.reposted_by !== null)
	) {
		return null;
	}
	const id = stringValue(source.id);
	const user = normalizeFxTwitterUser(source.author);
	if (!id || !user) return null;
	const replyingTo = record(source.replying_to);
	const replyId = stringValue(replyingTo?.status);
	const quoteSource = record(source.quote);
	const rawText = record(source.raw_text);
	const normalizedQuote = quoteSource
		? quoteSource.type === "tombstone"
			? normalizeTombstone(quoteSource)
			: normalizeFxTwitterTweet(quoteSource)
		: null;
	return {
		kind: "tweet",
		id,
		...(stringValue(source.url) ? { url: stringValue(source.url) } : {}),
		text: stringValue(rawText?.text) ?? stringValue(source.text) ?? "",
		createdAt: normalizeCreatedAt(source),
		...(stringValue(source.lang) ? { lang: stringValue(source.lang) } : {}),
		user,
		metrics: {
			likes: numberValue(source.likes) ?? 0,
			reposts: numberValue(source.reposts) ?? 0,
			quotes: numberValue(source.quotes) ?? 0,
			replies: numberValue(source.replies) ?? 0,
			...(numberValue(source.views) !== undefined
				? { views: numberValue(source.views) }
				: {}),
			...(numberValue(source.bookmarks) !== undefined
				? { bookmarks: numberValue(source.bookmarks) }
				: {}),
		},
		...(stringValue(source.conversation_id)
			? { conversationId: stringValue(source.conversation_id) }
			: {}),
		...(replyId
			? {
					reply: {
						id: replyId,
						screenName:
							stringValue(replyingTo?.screen_name)?.replace(/^@/, "") ?? "",
						...(stringValue(replyingTo?.url)
							? { url: stringValue(replyingTo?.url) }
							: {}),
						...(stringValue(replyingTo?.profile_url)
							? { profileUrl: stringValue(replyingTo?.profile_url) }
							: {}),
						...(stringValue(replyingTo?.display_name)
							? { displayName: stringValue(replyingTo?.display_name) }
							: {}),
					},
				}
			: {}),
		...(normalizedQuote ? { quote: normalizedQuote } : {}),
		media: normalizeMedia(source.media),
		facets: normalizeFacets(rawText),
		raw: source,
	};
}

export function normalizeFxTwitterTweets(values: unknown): FxTwitterTweet[] {
	const statuses = records(values).flatMap((entry) => {
		if (entry.type !== "thread") return [entry];
		const conversationId = stringValue(entry.conversation_id);
		return records(entry.statuses).map((status) => ({
			...status,
			...(conversationId && !stringValue(status.conversation_id)
				? { conversation_id: conversationId }
				: {}),
		}));
	});
	return statuses
		.map(normalizeFxTwitterTweet)
		.filter((tweet): tweet is FxTwitterTweet => tweet !== null);
}

function userToXurl(user: FxTwitterUser): XurlMentionUser {
	return {
		id: user.id,
		name: user.name,
		username: user.screenName,
		...(user.description ? { description: user.description } : {}),
		...(user.avatarUrl ? { profile_image_url: user.avatarUrl } : {}),
		...(user.verified !== undefined ? { verified: user.verified } : {}),
		public_metrics: {
			...(user.metrics.followers !== undefined
				? { followers_count: user.metrics.followers }
				: {}),
			...(user.metrics.following !== undefined
				? { following_count: user.metrics.following }
				: {}),
			...(user.metrics.statuses !== undefined
				? { tweet_count: user.metrics.statuses }
				: {}),
		},
	};
}

function mediaToXurl(tweet: FxTwitterTweet): XurlMedia[] {
	return tweet.media.map((media, index) => ({
		media_key: `${tweet.id}:${String(index)}`,
		type:
			media.type === "photo"
				? "photo"
				: media.type === "gif"
					? "animated_gif"
					: media.type,
		url: media.url,
		...(media.thumbnailUrl ? { preview_image_url: media.thumbnailUrl } : {}),
		...(media.durationSeconds !== undefined
			? { duration_ms: media.durationSeconds * 1_000 }
			: {}),
		...(media.width !== undefined ? { width: media.width } : {}),
		...(media.height !== undefined ? { height: media.height } : {}),
		...(media.altText ? { alt_text: media.altText } : {}),
		...(media.variants.length > 0
			? {
					variants: media.variants.map((variant) => ({
						url: variant.url,
						content_type: variant.contentType ?? "application/octet-stream",
						...(variant.bitRate !== undefined
							? { bit_rate: variant.bitRate }
							: {}),
					})),
				}
			: {}),
	}));
}

function tweetToXurl(tweet: FxTwitterTweet): XurlMentionData {
	const references = [
		...(tweet.reply ? [{ type: "replied_to", id: tweet.reply.id }] : []),
		...(tweet.quote?.id ? [{ type: "quoted", id: tweet.quote.id }] : []),
	];
	return {
		id: tweet.id,
		author_id: tweet.user.id,
		text: tweet.text,
		created_at: tweet.createdAt,
		...(tweet.conversationId ? { conversation_id: tweet.conversationId } : {}),
		...(tweet.media.length > 0
			? {
					attachments: {
						media_keys: tweet.media.map(
							(_media, index) => `${tweet.id}:${String(index)}`,
						),
					},
				}
			: {}),
		entities: {
			urls: tweet.facets
				.filter((facet) => facet.type === "url")
				.map((facet) => ({
					start: facet.start,
					end: facet.end,
					url: facet.original ?? facet.replacement ?? "",
					expanded_url: facet.replacement ?? facet.original ?? "",
					display_url:
						facet.display ?? facet.replacement ?? facet.original ?? "",
				})),
			mentions: tweet.facets
				.filter((facet) => facet.type === "mention")
				.map((facet) => ({
					start: facet.start,
					end: facet.end,
					username: (facet.display ?? facet.original ?? "").replace(/^@/, ""),
					...(facet.id ? { id: facet.id } : {}),
				})),
			hashtags: tweet.facets
				.filter((facet) => facet.type === "hashtag")
				.map((facet) => ({
					start: facet.start,
					end: facet.end,
					tag: (facet.display ?? facet.original ?? "").replace(/^#/, ""),
				})),
		},
		...(references.length > 0 ? { referenced_tweets: references } : {}),
		public_metrics: {
			like_count: tweet.metrics.likes,
			retweet_count: tweet.metrics.reposts,
			quote_count: tweet.metrics.quotes,
			reply_count: tweet.metrics.replies,
			...(tweet.metrics.views !== undefined
				? { impression_count: tweet.metrics.views }
				: {}),
			...(tweet.metrics.bookmarks !== undefined
				? { bookmark_count: tweet.metrics.bookmarks }
				: {}),
		},
	};
}

function collectTweets(tweets: FxTwitterTweet[]) {
	const collected = new Map<string, FxTwitterTweet>();
	const visit = (tweet: FxTwitterTweet) => {
		if (collected.has(tweet.id)) return;
		collected.set(tweet.id, tweet);
		if (tweet.quote?.kind === "tweet") visit(tweet.quote);
	};
	for (const tweet of tweets) visit(tweet);
	return collected;
}

export function fxTwitterTweetsToPayload(
	tweets: FxTwitterTweet[],
): XurlMentionsResponse {
	const allTweets = collectTweets(tweets);
	const users = new Map<string, XurlMentionUser>();
	const media: XurlMedia[] = [];
	for (const tweet of allTweets.values()) {
		users.set(tweet.user.id, userToXurl(tweet.user));
		media.push(...mediaToXurl(tweet));
	}
	const rootIds = new Set(tweets.map((tweet) => tweet.id));
	return {
		data: tweets.map(tweetToXurl),
		includes: {
			users: [...users.values()],
			tweets: [...allTweets.values()]
				.filter((tweet) => !rootIds.has(tweet.id))
				.map(tweetToXurl),
			media,
		},
		meta: { result_count: tweets.length, source: "fxtwitter" },
	};
}

export const adaptFxTwitterTweetsForIngest = fxTwitterTweetsToPayload;
