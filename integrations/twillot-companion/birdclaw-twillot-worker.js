(() => {
	"use strict";

	const PROTOCOL_VERSION = 1;
	const DEFAULT_ENDPOINT =
		"https://birdclaw-production.up.railway.app/api/integrations/twillot-history";
	const CLOUD_ENDPOINT = DEFAULT_ENDPOINT;
	const DATABASE_NAME = "twillot";
	const DATABASE_VERSION = 41;
	const POSTS_STORE = "posts";
	const SETTINGS_STORE = "settings";
	const PUBLIC_INDEX = "public_index";
	const CLAIM_ALARM = "birdclaw-twillot-claim";
	const RETRY_ALARM = "birdclaw-twillot-retry";
	const CLAIM_INTERVAL_MINUTES = 5;
	const RETRY_INTERVAL_MINUTES = 1;
	const FRESHNESS_STABLE_MS = 5_000;
	const RETRY_BASE_MS = 30_000;
	const RETRY_MAX_MS = 15 * 60_000;
	const MAX_BATCH_RECORDS = 200;
	const MAX_BODY_BYTES = 1_500_000;
	const MAX_RESPONSE_BYTES = 64 * 1024;
	const STORAGE = {
		settings: "birdclawTwillotSettings",
		identity: "birdclawTwillotIdentity",
		activeJob: "birdclawTwillotActiveJob",
		capture: "birdclawTwillotCapture",
		outbox: "birdclawTwillotOutbox",
		status: "birdclawTwillotStatus",
	};
	const CONTROL = {
		getState: "birdclaw:twillot:get-state",
		saveSettings: "birdclaw:twillot:save-settings",
		syncNow: "birdclaw:twillot:sync-now",
		getActiveJob: "birdclaw:twillot:get-active-job",
		pageOpened: "birdclaw:twillot:page-opened",
		openOptions: "birdclaw:twillot:open-options",
	};
	const DEFAULT_STATUS = {
		state: "idle",
		lastAttemptAt: null,
		lastSuccessAt: null,
		lastError: null,
	};
	const EXPECTED_POST_INDEXES = new Set([
		"owner_category_sort_index",
		"public_index",
		"owner_category_public_created_at_sort_index",
		"public_count_index",
		"onwer_category_index",
		"owner_category_created_at_index",
		"owner_user_created_at",
		"owner_created_at_index",
	]);

	let stateQueue = Promise.resolve();
	let activeFlush = null;
	let activeClaim = null;
	let activeScan = null;

	class CompanionError extends Error {}

	class PermanentCaptureError extends CompanionError {}

	class HttpResponseError extends CompanionError {
		constructor(message, status, code) {
			super(message);
			this.status = status;
			this.code = code;
		}
	}

	function serialize(work) {
		const result = stateQueue.then(work, work);
		stateQueue = result.catch(() => {});
		return result;
	}

	async function getStored(key) {
		const result = await chrome.storage.local.get(key);
		return result[key];
	}

	async function setStored(key, value) {
		await chrome.storage.local.set({ [key]: value });
	}

	async function mergeStatus(patch) {
		const current = await getStored(STORAGE.status);
		const next = {
			...DEFAULT_STATUS,
			...(current && typeof current === "object" ? current : {}),
			...patch,
		};
		await setStored(STORAGE.status, next);
		return next;
	}

	function controlledError(error) {
		if (error instanceof CompanionError) return error.message;
		if (error instanceof TypeError) return "BirdClaw is unreachable.";
		return "The Twillot companion could not complete the local request.";
	}

	function isStaleLeaseError(error) {
		return (
			error instanceof HttpResponseError &&
			error.status === 409 &&
			error.code === "STALE_LEASE"
		);
	}

	function isPermanentJobError(error) {
		return (
			error instanceof PermanentCaptureError ||
			(error instanceof HttpResponseError &&
				error.status === 409 &&
				error.code === "TARGET_MISMATCH")
		);
	}

	function normalizeEndpoint(value) {
		let parsed;
		try {
			parsed = new URL(String(value || DEFAULT_ENDPOINT));
		} catch {
			throw new CompanionError("Enter a valid BirdClaw companion endpoint.");
		}
		const isLoopback =
			parsed.protocol === "http:" &&
			["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
		const isCloud = parsed.toString().replace(/\/$/, "") === CLOUD_ENDPOINT;
		if (
			(!isLoopback && !isCloud) ||
			parsed.username ||
			parsed.password ||
			parsed.search ||
			parsed.hash
		) {
			throw new CompanionError(
				"Use the official BirdClaw cloud endpoint or an uncredentialed http:// loopback URL.",
			);
		}
		parsed.pathname = parsed.pathname.replace(/\/+$/, "");
		if (!parsed.pathname)
			throw new CompanionError("The endpoint must include an API path.");
		return parsed.toString().replace(/\/$/, "");
	}

	function validToken(value) {
		return (
			typeof value === "string" &&
			value.length >= 40 &&
			value.length <= 128 &&
			!/[\r\n]/.test(value)
		);
	}

	function normalizedUid(value) {
		return typeof value === "string"
			? value.trim().replace(/^@/, "").toLowerCase()
			: "";
	}

	function isTwillotExportUrl(value) {
		try {
			const url = new URL(value);
			return (
				url.origin === "https://www.twillot.com" &&
				/(^|\/)export-twitter-posts\/?$/.test(url.pathname)
			);
		} catch {
			return false;
		}
	}

	function validCursor(value) {
		return (
			value === null ||
			(value &&
				typeof value === "object" &&
				Array.isArray(value.indexKey) &&
				typeof value.primaryKey === "string")
		);
	}

	function validJob(value) {
		return Boolean(
			value &&
			typeof value === "object" &&
			typeof value.id === "string" &&
			value.id.length > 0 &&
			value.id.length <= 200 &&
			typeof value.handle === "string" &&
			value.handle.length > 0 &&
			value.handle.length <= 64 &&
			typeof value.externalUserId === "string" &&
			value.externalUserId.length > 0 &&
			value.externalUserId.length <= 128 &&
			typeof value.leaseToken === "string" &&
			value.leaseToken.length >= 8 &&
			value.leaseToken.length <= 2048 &&
			Number.isSafeInteger(value.allowance) &&
			value.allowance >= 1 &&
			value.allowance <= 20_000 &&
			validCursor(value.cursor ?? null),
		);
	}

	function pageMatchesJob(pageUid, job) {
		const page = normalizedUid(pageUid);
		return Boolean(
			page &&
			(page === normalizedUid(job.handle) ||
				page === normalizedUid(job.externalUserId)),
		);
	}

	async function readSettings() {
		const stored = await getStored(STORAGE.settings);
		return {
			endpoint: normalizeEndpoint(stored?.endpoint || DEFAULT_ENDPOINT),
			token: validToken(stored?.token) ? stored.token : null,
		};
	}

	async function ensureIdentity() {
		const stored = await getStored(STORAGE.identity);
		if (
			stored &&
			typeof stored.sourceId === "string" &&
			/^[0-9a-f-]{36}$/i.test(stored.sourceId)
		) {
			return stored;
		}
		const identity = { sourceId: crypto.randomUUID() };
		await setStored(STORAGE.identity, identity);
		return identity;
	}

	async function parseResponse(response) {
		const text = await response.text();
		if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
			throw new CompanionError("BirdClaw returned an oversized response.");
		}
		if (!text) return {};
		try {
			return JSON.parse(text);
		} catch {
			throw new CompanionError("BirdClaw returned invalid JSON.");
		}
	}

	async function localFetch(url, settings, init = {}) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 15_000);
		try {
			return await fetch(url, {
				...init,
				signal: controller.signal,
				credentials: "omit",
				cache: "no-store",
				headers: {
					Accept: "application/json",
					Authorization: `Bearer ${settings.token}`,
					"X-BirdClaw-Integration": "twillot-history-v1",
					...init.headers,
				},
			});
		} finally {
			clearTimeout(timer);
		}
	}

	async function findMatchingTab(job) {
		const tabs = await chrome.tabs.query({
			url: [
				"https://www.twillot.com/export-twitter-posts*",
				"https://www.twillot.com/*/export-twitter-posts*",
			],
		});
		return tabs.find((tab) => {
			if (!tab?.url || !isTwillotExportUrl(tab.url)) return false;
			return pageMatchesJob(
				new URL(tab.url).searchParams.get("publicUid"),
				job,
			);
		});
	}

	async function ensureJobTab(job, active = false) {
		const existing = await findMatchingTab(job);
		if (existing) return existing;
		return chrome.tabs.create({
			url: `https://www.twillot.com/export-twitter-posts?publicUid=${encodeURIComponent(job.handle)}`,
			active,
		});
	}

	async function openExistingDatabase() {
		if (typeof indexedDB.databases === "function") {
			let databases;
			try {
				databases = await indexedDB.databases();
			} catch {
				throw new CompanionError("Twillot storage cannot be enumerated.");
			}
			const descriptor = databases.find(
				(database) => database?.name === DATABASE_NAME,
			);
			if (!descriptor)
				throw new CompanionError("Twillot storage is not ready yet.");
			if (descriptor.version !== DATABASE_VERSION) {
				throw new PermanentCaptureError(
					`Unsupported Twillot database version ${descriptor.version ?? "unknown"}.`,
				);
			}
		}
		const request = indexedDB.open(DATABASE_NAME);
		return new Promise((resolve, reject) => {
			let settled = false;
			const fail = (message) => {
				if (settled) return;
				settled = true;
				reject(new CompanionError(message));
			};
			request.onupgradeneeded = () => {
				try {
					request.transaction?.abort();
				} catch {}
				fail("Twillot storage is not ready yet.");
			};
			request.onerror = () => fail("Twillot storage could not be opened.");
			request.onblocked = () => fail("Twillot storage is blocked.");
			request.onsuccess = () => {
				if (settled) return request.result?.close();
				settled = true;
				resolve(request.result);
			};
		});
	}

	function assertSchema(database) {
		if (database.version !== DATABASE_VERSION) {
			throw new PermanentCaptureError(
				`Unsupported Twillot database version ${database.version}.`,
			);
		}
		if (
			!database.objectStoreNames.contains(POSTS_STORE) ||
			!database.objectStoreNames.contains(SETTINGS_STORE)
		) {
			throw new PermanentCaptureError(
				"This Twillot version has an unsupported storage schema.",
			);
		}
		const transaction = database.transaction(
			[POSTS_STORE, SETTINGS_STORE],
			"readonly",
		);
		const posts = transaction.objectStore(POSTS_STORE);
		const settings = transaction.objectStore(SETTINGS_STORE);
		if (
			posts.keyPath !== "id" ||
			posts.autoIncrement ||
			settings.keyPath !== "id" ||
			settings.autoIncrement ||
			!posts.indexNames.contains(PUBLIC_INDEX)
		) {
			transaction.abort();
			throw new PermanentCaptureError(
				"This Twillot version has an unsupported storage schema.",
			);
		}
		for (const indexName of EXPECTED_POST_INDEXES) {
			if (!posts.indexNames.contains(indexName)) {
				transaction.abort();
				throw new PermanentCaptureError(
					"This Twillot version has an unsupported posts schema.",
				);
			}
		}
		if (
			JSON.stringify(posts.index(PUBLIC_INDEX).keyPath) !==
			JSON.stringify(["owner_id", "category_name", "user_id", "sort_index"])
		) {
			transaction.abort();
			throw new PermanentCaptureError(
				"This Twillot version has an unsupported public index.",
			);
		}
	}

	function requestAsPromise(request, message) {
		return new Promise((resolve, reject) => {
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(new CompanionError(message));
		});
	}

	async function readSyncSettings(database, externalUserId) {
		const transaction = database.transaction([SETTINGS_STORE], "readonly");
		const completion = new Promise((resolve, reject) => {
			transaction.oncomplete = resolve;
			transaction.onerror = () =>
				reject(new CompanionError("Twillot settings could not be read."));
			transaction.onabort = () =>
				reject(new CompanionError("Twillot settings could not be read."));
		});
		const rows = await requestAsPromise(
			transaction.objectStore(SETTINGS_STORE).getAll(),
			"Twillot settings could not be read.",
		);
		await completion;
		if (!Array.isArray(rows) || rows.length > 20_000) {
			throw new PermanentCaptureError(
				"Twillot settings exceed the safe read limit.",
			);
		}
		const prefix = `public-post_${externalUserId}_`;
		const matches = rows
			.filter(
				(row) =>
					row &&
					typeof row.id === "string" &&
					row.id.startsWith(prefix) &&
					row.id.endsWith("_lastSyncTime") &&
					typeof row.owner_id === "string" &&
					row.owner_id.length > 0 &&
					Number(row.option_value) > 0,
			)
			.sort(
				(left, right) =>
					Number(right.updated_at || 0) - Number(left.updated_at || 0),
			);
		const row = matches[0];
		return row
			? { ownerId: row.owner_id, lastSyncTime: Number(row.option_value) }
			: null;
	}

	function captureMatchesJob(capture, job) {
		return Boolean(
			capture &&
			capture.jobId === job.id &&
			capture.externalUserId === job.externalUserId,
		);
	}

	function captureEntries(stored) {
		if (stored?.version === 1 && Array.isArray(stored.entries)) {
			return stored.entries.filter(
				(entry) =>
					entry &&
					typeof entry.jobId === "string" &&
					typeof entry.externalUserId === "string",
			);
		}
		return stored?.jobId && stored?.externalUserId ? [stored] : [];
	}

	async function getJobCapture(job) {
		const stored = await getStored(STORAGE.capture);
		return (
			captureEntries(stored).find((capture) =>
				captureMatchesJob(capture, job),
			) ?? null
		);
	}

	async function saveJobCapture(capture) {
		const entries = captureEntries(await getStored(STORAGE.capture)).filter(
			(entry) =>
				entry.jobId !== capture.jobId ||
				entry.externalUserId !== capture.externalUserId,
		);
		entries.push(capture);
		await setStored(STORAGE.capture, {
			version: 1,
			entries,
		});
		return capture;
	}

	function baselineCapture(job, syncSettings, now = Date.now()) {
		return {
			jobId: job.id,
			externalUserId: job.externalUserId,
			baselineCaptured: true,
			baselineLastSyncTime: syncSettings?.lastSyncTime ?? null,
			observedLastSyncTime: null,
			stableSince: null,
			approvedLastSyncTime: null,
			capturedAt: now,
		};
	}

	function pendingCapture(job, now = Date.now()) {
		return {
			jobId: job.id,
			externalUserId: job.externalUserId,
			baselineCaptured: false,
			baselineLastSyncTime: null,
			observedLastSyncTime: null,
			stableSince: null,
			approvedLastSyncTime: null,
			capturedAt: now,
		};
	}

	function evaluateFreshness(capture, syncSettings, now = Date.now()) {
		if (!capture?.baselineCaptured) {
			return {
				ready: false,
				capture: baselineCapture(
					{
						id: capture?.jobId,
						externalUserId: capture?.externalUserId,
					},
					syncSettings,
					now,
				),
			};
		}
		if (!syncSettings) {
			return {
				ready: false,
				capture: {
					...capture,
					observedLastSyncTime: null,
					stableSince: null,
				},
			};
		}
		const current = syncSettings.lastSyncTime;
		if (capture.approvedLastSyncTime === current) {
			return { ready: true, capture, lastSyncTime: current };
		}
		if (
			capture.baselineLastSyncTime !== null &&
			current <= capture.baselineLastSyncTime
		) {
			return {
				ready: false,
				capture: {
					...capture,
					observedLastSyncTime: null,
					stableSince: null,
				},
			};
		}
		if (capture.observedLastSyncTime !== current) {
			return {
				ready: false,
				capture: {
					...capture,
					observedLastSyncTime: current,
					stableSince: now,
				},
			};
		}
		if (
			typeof capture.stableSince !== "number" ||
			now - capture.stableSince < FRESHNESS_STABLE_MS
		) {
			return { ready: false, capture };
		}
		return {
			ready: true,
			lastSyncTime: current,
			capture: { ...capture, approvedLastSyncTime: current },
		};
	}

	async function establishCaptureBaseline(job) {
		const existing = await getJobCapture(job);
		if (existing) return existing;
		let database;
		try {
			database = await openExistingDatabase();
			assertSchema(database);
			const syncSettings = await readSyncSettings(database, job.externalUserId);
			const capture = baselineCapture(job, syncSettings);
			return saveJobCapture(capture);
		} catch (error) {
			if (error instanceof PermanentCaptureError) throw error;
			const capture = pendingCapture(job);
			return saveJobCapture(capture);
		} finally {
			database?.close();
		}
	}

	function jsonSafe(value, seen = new WeakSet()) {
		if (
			value === null ||
			typeof value === "string" ||
			typeof value === "boolean"
		)
			return value;
		if (typeof value === "number") {
			if (!Number.isFinite(value))
				throw new PermanentCaptureError("A Twillot row is not JSON-safe.");
			return value;
		}
		if (value instanceof Date) return value.toISOString();
		if (typeof value !== "object" || seen.has(value)) {
			throw new PermanentCaptureError("A Twillot row is not JSON-safe.");
		}
		seen.add(value);
		try {
			if (Array.isArray(value))
				return value.map((item) => jsonSafe(item, seen));
			if (Object.prototype.toString.call(value) !== "[object Object]") {
				throw new PermanentCaptureError(
					"A Twillot row contains an unsupported value.",
				);
			}
			const result = {};
			for (const [key, item] of Object.entries(value)) {
				if (item !== undefined) result[key] = jsonSafe(item, seen);
			}
			return result;
		} finally {
			seen.delete(value);
		}
	}

	function asPlainRecord(value) {
		return value &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			Object.prototype.toString.call(value) === "[object Object]"
			? value
			: null;
	}

	function stringValue(value) {
		if (typeof value !== "string" && typeof value !== "number") return null;
		const normalized = String(value).trim();
		return normalized || null;
	}

	function nonNegativeInteger(value) {
		const parsed = Number(value);
		return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
	}

	function projectEntities(value) {
		const source = asPlainRecord(value);
		if (!source) return undefined;
		const result = {};
		const tags = (items) =>
			Array.isArray(items)
				? items
						.slice(0, 64)
						.map((item) => asPlainRecord(item))
						.map((item) => stringValue(item?.tag ?? item?.text))
						.filter(Boolean)
						.map((tag) => ({ tag }))
				: [];
		const hashtags = tags(source.hashtags);
		if (hashtags.length) result.hashtags = hashtags;
		const cashtags = tags(source.symbols ?? source.cashtags);
		if (cashtags.length) result.cashtags = cashtags;
		if (Array.isArray(source.user_mentions ?? source.mentions)) {
			const mentions = (source.user_mentions ?? source.mentions)
				.slice(0, 64)
				.map((item) => asPlainRecord(item))
				.map((item) => {
					const username = stringValue(item?.username ?? item?.screen_name);
					if (!username) return null;
					const id = stringValue(item?.id ?? item?.id_str);
					return { ...(id ? { id } : {}), username };
				})
				.filter(Boolean);
			if (mentions.length) result.mentions = mentions;
		}
		if (Array.isArray(source.urls)) {
			const urls = source.urls
				.slice(0, 64)
				.map((item) => asPlainRecord(item))
				.map((item) => {
					const url = stringValue(item?.url);
					if (!url) return null;
					const expandedUrl = stringValue(
						item?.expanded_url ?? item?.expandedUrl,
					);
					const displayUrl = stringValue(item?.display_url ?? item?.displayUrl);
					const indices = Array.isArray(item?.indices)
						? item.indices.map(nonNegativeInteger)
						: [];
					return {
						url,
						...(expandedUrl ? { expanded_url: expandedUrl } : {}),
						...(displayUrl ? { display_url: displayUrl } : {}),
						...(indices.length === 2 && indices.every((index) => index !== null)
							? { start: indices[0], end: indices[1] }
							: {}),
					};
				})
				.filter(Boolean);
			if (urls.length) result.urls = urls;
		}
		return Object.keys(result).length ? result : undefined;
	}

	function projectVideoInfo(value) {
		const source = asPlainRecord(value);
		if (!source) return undefined;
		const result = {};
		const duration = nonNegativeInteger(
			source.duration_millis ?? source.durationMillis,
		);
		if (duration !== null) result.duration_millis = duration;
		if (
			Array.isArray(source.aspect_ratio) &&
			source.aspect_ratio.length === 2 &&
			source.aspect_ratio.every((item) => nonNegativeInteger(item) !== null)
		) {
			result.aspect_ratio = source.aspect_ratio.map(Number);
		}
		if (Array.isArray(source.variants)) {
			const variants = source.variants
				.slice(0, 32)
				.map((item) => asPlainRecord(item))
				.map((item) => {
					const url = stringValue(item?.url);
					const contentType = stringValue(
						item?.content_type ?? item?.contentType,
					);
					if (!url || !contentType) return null;
					const bitrate = nonNegativeInteger(item?.bitrate ?? item?.bit_rate);
					return {
						url,
						content_type: contentType,
						...(bitrate !== null ? { bitrate } : {}),
					};
				})
				.filter(Boolean);
			if (variants.length) result.variants = variants;
		}
		return Object.keys(result).length ? result : undefined;
	}

	function projectMediaItems(raw, legacy) {
		const extended = asPlainRecord(legacy.extended_entities);
		const candidates = [
			...(Array.isArray(raw.media_items) ? raw.media_items : []),
			...(Array.isArray(extended?.media) ? extended.media : []),
		];
		const blockedVideoKeys = new Set();
		for (const candidate of candidates) {
			const item = asPlainRecord(candidate);
			if (!item) continue;
			const type = stringValue(item.type);
			if (
				type !== "video" &&
				type !== "animated_gif" &&
				(type === "photo" || !projectVideoInfo(item.video_info))
			)
				continue;
			const key = stringValue(
				item.media_key ??
					item.id ??
					item.id_str ??
					item.url ??
					item.preview_image_url ??
					item.media_url_https ??
					item.media_url,
			);
			if (key) blockedVideoKeys.add(key);
		}
		const seen = new Set();
		const result = [];
		for (const candidate of candidates) {
			if (result.length >= 64) break;
			const item = asPlainRecord(candidate);
			if (!item) continue;
			const mediaKey = stringValue(item.media_key);
			const id = stringValue(item.id ?? item.id_str);
			const url = stringValue(item.url);
			const preview = stringValue(item.preview_image_url);
			const mediaUrl = stringValue(item.media_url);
			const mediaUrlHttps = stringValue(item.media_url_https);
			if (!mediaKey && !id && !url && !preview && !mediaUrl && !mediaUrlHttps)
				continue;
			const dedupeKey =
				mediaKey ?? id ?? url ?? preview ?? mediaUrlHttps ?? mediaUrl;
			if (blockedVideoKeys.has(dedupeKey)) continue;
			if (seen.has(dedupeKey)) continue;
			const type = stringValue(item.type);
			const videoInfo = projectVideoInfo(item.video_info);
			if (
				type === "video" ||
				type === "animated_gif" ||
				(type !== "photo" && videoInfo)
			)
				continue;
			seen.add(dedupeKey);
			const width = nonNegativeInteger(item.width);
			const height = nonNegativeInteger(item.height);
			result.push({
				...(mediaKey ? { media_key: mediaKey } : {}),
				...(id ? { id } : {}),
				...(type ? { type } : {}),
				...(url ? { url } : {}),
				...(preview ? { preview_image_url: preview } : {}),
				...(mediaUrl ? { media_url: mediaUrl } : {}),
				...(mediaUrlHttps ? { media_url_https: mediaUrlHttps } : {}),
				...(width !== null ? { width } : {}),
				...(height !== null ? { height } : {}),
			});
		}
		return result;
	}

	function projectQuotedPost(value) {
		const raw = asPlainRecord(value);
		if (!raw) return undefined;
		const tweetId = stringValue(raw.tweet_id ?? raw.rest_id ?? raw.id);
		const userId = stringValue(raw.user_id);
		const screenName = stringValue(raw.screen_name);
		const fullText = typeof raw.full_text === "string" ? raw.full_text : null;
		const createdAt = raw.created_at;
		if (
			!tweetId ||
			!/^\d+$/.test(tweetId) ||
			!userId ||
			!screenName ||
			!fullText ||
			fullText.length > 100_000 ||
			!(typeof createdAt === "string" || typeof createdAt === "number")
		) {
			throw new PermanentCaptureError(
				"A quoted Twillot post failed schema checks.",
			);
		}
		const result = {
			tweet_id: tweetId,
			user_id: userId,
			created_at: createdAt,
			full_text: fullText,
			screen_name: screenName,
		};
		for (const [key, item] of Object.entries({
			conversation_id: raw.conversation_id,
			username: raw.username,
			avatar_url: raw.avatar_url,
			lang: raw.lang,
			reply_to_id: raw.reply_to_id,
			quoted_tweet_id: raw.quoted_tweet_id,
		})) {
			const normalized = stringValue(item);
			if (normalized) result[key] = normalized;
		}
		for (const key of [
			"views_count",
			"bookmark_count",
			"favorite_count",
			"quote_count",
			"reply_count",
			"retweet_count",
		]) {
			const count = nonNegativeInteger(raw[key]);
			if (count !== null) result[key] = count;
		}
		for (const key of ["is_reply", "is_quote"]) {
			if (typeof raw[key] === "boolean") result[key] = raw[key];
		}
		const entities = projectEntities(raw.entities);
		if (entities) result.entities = entities;
		const mediaItems = projectMediaItems(raw, {});
		if (mediaItems.length) result.media_items = mediaItems;
		return result;
	}

	function projectPostRecord(value, job, ownerId, primaryKey) {
		const raw = asPlainRecord(value);
		if (!raw) {
			throw new PermanentCaptureError(
				"A Twillot public-post row failed schema checks.",
			);
		}
		const data = asPlainRecord(raw._data);
		const legacy = asPlainRecord(data?.legacy) ?? data ?? {};
		const id = stringValue(raw.id);
		const explicitTweetId = stringValue(
			raw.tweet_id ?? raw.rest_id ?? data?.rest_id ?? legacy.id_str,
		);
		const tweetId = explicitTweetId ?? (/^\d+$/.test(id ?? "") ? id : null);
		const userId = stringValue(raw.user_id);
		const screenName = stringValue(raw.screen_name ?? legacy.screen_name);
		const createdAt = raw.created_at ?? legacy.created_at;
		const fullText =
			typeof raw.full_text === "string"
				? raw.full_text
				: typeof legacy.full_text === "string"
					? legacy.full_text
					: null;
		if (
			raw.category_name !== "public-post" ||
			stringValue(raw.owner_id) !== ownerId ||
			userId !== job.externalUserId ||
			!id ||
			String(primaryKey) !== id ||
			!tweetId ||
			!(typeof createdAt === "string" || typeof createdAt === "number") ||
			!fullText ||
			fullText.length > 100_000 ||
			!screenName ||
			normalizedUid(screenName) !== normalizedUid(job.handle)
		) {
			throw new PermanentCaptureError(
				"A Twillot public-post row failed schema checks.",
			);
		}
		const result = {
			id,
			tweet_id: tweetId,
			owner_id: ownerId,
			user_id: userId,
			category_name: "public-post",
			created_at: createdAt,
			full_text: fullText,
			screen_name: screenName,
		};
		const optionalStrings = {
			conversation_id: raw.conversation_id ?? legacy.conversation_id_str,
			sort_index: raw.sort_index,
			username: raw.username,
			avatar_url: raw.avatar_url,
			lang: raw.lang ?? legacy.lang,
			reply_to_id:
				raw.reply_to_id ??
				legacy.in_reply_to_status_id_str ??
				legacy.in_reply_to_status_id,
			quoted_tweet_id:
				raw.quoted_tweet_id ??
				legacy.quoted_status_id_str ??
				legacy.quoted_status_id,
		};
		for (const [key, item] of Object.entries(optionalStrings)) {
			const normalized = stringValue(item);
			if (normalized) result[key] = normalized;
		}
		for (const key of [
			"views_count",
			"bookmark_count",
			"favorite_count",
			"quote_count",
			"reply_count",
			"retweet_count",
		]) {
			const count = nonNegativeInteger(raw[key]);
			if (count !== null) result[key] = count;
		}
		for (const key of ["is_reply", "is_quote"]) {
			if (typeof raw[key] === "boolean") result[key] = raw[key];
		}
		const entities = projectEntities(raw.entities ?? legacy.entities);
		if (entities) result.entities = entities;
		const mediaItems = projectMediaItems(raw, legacy);
		if (mediaItems.length) result.media_items = mediaItems;
		const quotedPost = projectQuotedPost(raw.quoted_tweet);
		if (quotedPost) {
			result.quoted_tweet = quotedPost;
			if (!result.quoted_tweet_id) result.quoted_tweet_id = quotedPost.tweet_id;
		}
		return result;
	}

	function checkpointEqual(checkpoint, cursor) {
		return Boolean(
			checkpoint &&
			checkpoint.primaryKey === String(cursor.primaryKey) &&
			JSON.stringify(checkpoint.indexKey) === JSON.stringify(cursor.key),
		);
	}

	async function readPostBatch(database, job, syncSettings) {
		const limit = Math.min(MAX_BATCH_RECORDS, job.allowance);
		const transaction = database.transaction([POSTS_STORE], "readonly");
		const completion = new Promise((resolve, reject) => {
			transaction.oncomplete = resolve;
			transaction.onerror = () =>
				reject(new CompanionError("Twillot posts could not be read."));
			transaction.onabort = () =>
				reject(new CompanionError("Twillot posts could not be read."));
		});
		const index = transaction.objectStore(POSTS_STORE).index(PUBLIC_INDEX);
		const range = IDBKeyRange.bound(
			[syncSettings.ownerId, "public-post", job.externalUserId, ""],
			[syncSettings.ownerId, "public-post", job.externalUserId, "\uffff"],
		);
		const request = index.openCursor(range, "prev");
		const records = [];
		let checkpointFound = job.cursor == null;
		let hasMore = false;
		let cursorValue = job.cursor ?? null;
		await new Promise((resolve, reject) => {
			request.onerror = () =>
				reject(new CompanionError("Twillot posts could not be read."));
			request.onsuccess = () => {
				const cursor = request.result;
				if (!cursor) return resolve();
				if (!checkpointFound) {
					if (checkpointEqual(job.cursor, cursor)) checkpointFound = true;
					cursor.continue();
					return;
				}
				if (records.length >= limit) {
					hasMore = true;
					resolve();
					return;
				}
				let value;
				try {
					value = projectPostRecord(
						cursor.value,
						job,
						syncSettings.ownerId,
						cursor.primaryKey,
					);
				} catch (error) {
					reject(error);
					return;
				}
				const projected = new TextEncoder().encode(
					JSON.stringify([...records, value]),
				).byteLength;
				if (projected > 1_250_000) {
					if (records.length === 0) {
						reject(
							new PermanentCaptureError(
								"A Twillot post exceeds the safe batch size.",
							),
						);
						return;
					}
					hasMore = true;
					resolve();
					return;
				}
				records.push(value);
				cursorValue = {
					indexKey: jsonSafe(cursor.key),
					primaryKey: value.id,
				};
				cursor.continue();
			};
		});
		await completion;
		if (!checkpointFound) {
			throw new PermanentCaptureError(
				"The saved Twillot cursor no longer exists; import stopped safely.",
			);
		}
		return { records, cursor: cursorValue, hasMore };
	}

	function stableStringify(value) {
		if (value === null || typeof value !== "object")
			return JSON.stringify(value);
		if (Array.isArray(value))
			return `[${value.map(stableStringify).join(",")}]`;
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
			.join(",")}}`;
	}

	async function stableBatchId(job, records, cursor, done) {
		const digest = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(
				stableStringify({
					jobId: job.id,
					externalUserId: job.externalUserId,
					before: job.cursor ?? null,
					cursor,
					recordIds: records.map((record) => record.id),
					done,
				}),
			),
		);
		return `bc-twillot-${[...new Uint8Array(digest)]
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("")
			.slice(0, 32)}`;
	}

	async function postAction(body) {
		const [settings, identity] = await Promise.all([
			readSettings(),
			ensureIdentity(),
		]);
		if (!settings.token)
			throw new CompanionError("A BirdClaw pairing token is required.");
		const payload = { ...body, sourceId: identity.sourceId };
		const encoded = JSON.stringify(payload);
		if (new TextEncoder().encode(encoded).byteLength > MAX_BODY_BYTES) {
			throw new PermanentCaptureError(
				"The Twillot request exceeds the upload limit.",
			);
		}
		const response = await localFetch(settings.endpoint, settings, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: encoded,
		});
		const data = await parseResponse(response);
		if (!response.ok || data.ok === false) {
			throw new HttpResponseError(
				response.status === 401 || response.status === 403
					? "BirdClaw rejected the pairing token."
					: "BirdClaw rejected the Twillot request.",
				response.status,
				typeof data.code === "string" ? data.code : null,
			);
		}
		return data;
	}

	async function claimNextJob() {
		if (activeClaim) return activeClaim;
		activeClaim = (async () => {
			const existing = await getStored(STORAGE.activeJob);
			if (validJob(existing)) {
				const capture = await getJobCapture(existing);
				if (!capture || !capture.baselineCaptured) {
					await chrome.alarms.create(RETRY_ALARM, {
						when: Date.now() + RETRY_BASE_MS,
					});
					return {
						ok: true,
						job: existing,
						existing: true,
						baselinePending: true,
					};
				}
				await ensureJobTab(existing);
				return { ok: true, job: existing, existing: true };
			}
			if (await getStored(STORAGE.outbox))
				return { ok: true, pendingBatch: true };
			const [settings, identity] = await Promise.all([
				readSettings(),
				ensureIdentity(),
			]);
			if (!settings.token) {
				await mergeStatus({
					state: "needs-pairing",
					lastError: "A BirdClaw pairing token is required.",
				});
				return { ok: false, needsPairing: true };
			}
			await mergeStatus({
				state: "checking-queue",
				lastAttemptAt: Date.now(),
				lastError: null,
			});
			const url = new URL(settings.endpoint);
			url.searchParams.set("sourceId", identity.sourceId);
			url.searchParams.set("requestedCap", String(MAX_BATCH_RECORDS));
			const response = await localFetch(url.toString(), settings, {
				method: "GET",
			});
			const data = await parseResponse(response);
			if (!response.ok || data.ok === false) {
				throw new CompanionError(
					response.status === 401 || response.status === 403
						? "BirdClaw rejected the pairing token."
						: "BirdClaw could not provide the next Twillot job.",
				);
			}
			if (!data.job) {
				await mergeStatus({ state: "queue-empty", lastError: null });
				return { ok: true, empty: true };
			}
			if (!validJob(data.job))
				throw new CompanionError("BirdClaw returned an invalid Twillot job.");
			const job = {
				...data.job,
				cursor: data.job.cursor ?? null,
				claimedAt: Date.now(),
			};
			let capture;
			try {
				capture = await establishCaptureBaseline(job);
			} catch (error) {
				if (!(error instanceof PermanentCaptureError)) throw error;
				await mergeStatus({
					state: "schema-blocked",
					lastError: controlledError(error),
				});
				await reportJobError(job, error);
				await chrome.alarms.create(CLAIM_ALARM, {
					when: Date.now() + RETRY_BASE_MS,
				});
				return { ok: false, permanent: true };
			}
			await setStored(STORAGE.activeJob, job);
			if (!capture.baselineCaptured) {
				await mergeStatus({
					state: "waiting-for-storage",
					lastError: "Waiting to record Twillot's pre-export sync baseline.",
				});
				await chrome.alarms.create(RETRY_ALARM, {
					when: Date.now() + RETRY_BASE_MS,
				});
				return { ok: true, job, baselinePending: true };
			}
			await mergeStatus({ state: "waiting-for-twillot", lastError: null });
			await ensureJobTab(job, true);
			return { ok: true, job };
		})()
			.catch(async (error) => {
				await mergeStatus({
					state: "retrying",
					lastError: controlledError(error),
				});
				throw error;
			})
			.finally(() => {
				activeClaim = null;
			});
		return activeClaim;
	}

	function outboxRetryDelay(attempts) {
		const exponent = Math.max(0, Math.min(20, attempts - 1));
		return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** exponent);
	}

	async function removeMatchingCapture(jobId) {
		const entries = captureEntries(await getStored(STORAGE.capture)).filter(
			(capture) => capture.jobId !== jobId,
		);
		if (entries.length === 0) {
			await chrome.storage.local.remove(STORAGE.capture);
		} else {
			await setStored(STORAGE.capture, { version: 1, entries });
		}
	}

	async function discardStaleLease(jobId) {
		const job = await getStored(STORAGE.activeJob);
		if (job?.id === jobId) {
			await chrome.storage.local.remove(STORAGE.activeJob);
		}
		const outbox = await getStored(STORAGE.outbox);
		if (outbox?.body?.jobId === jobId) {
			await chrome.storage.local.remove(STORAGE.outbox);
		}
		await mergeStatus({
			state: "checking-queue",
			lastError: "The batch lease expired; requesting a fresh cursor.",
		});
		await chrome.alarms.create(CLAIM_ALARM, { when: Date.now() + 1_000 });
	}

	async function flushOutbox() {
		if (activeFlush) return activeFlush;
		activeFlush = (async () => {
			const outbox = await getStored(STORAGE.outbox);
			if (!outbox?.batchId || !outbox?.body) return { ok: true, empty: true };
			if (
				typeof outbox.nextAttemptAt === "number" &&
				outbox.nextAttemptAt > Date.now()
			) {
				await chrome.alarms.create(RETRY_ALARM, {
					when: outbox.nextAttemptAt,
				});
				return { ok: false, queued: true, deferred: true };
			}
			try {
				await mergeStatus({
					state: "uploading",
					lastAttemptAt: Date.now(),
					lastError: null,
				});
				await postAction(outbox.body);
				const job = await getStored(STORAGE.activeJob);
				if (job?.id === outbox.body.jobId) {
					await chrome.storage.local.remove(STORAGE.activeJob);
				}
				if (outbox.body.done) {
					await removeMatchingCapture(outbox.body.jobId);
				}
				const current = await getStored(STORAGE.outbox);
				if (current?.batchId === outbox.batchId)
					await chrome.storage.local.remove(STORAGE.outbox);
				await mergeStatus({
					state: outbox.body.done ? "caught_up_unverified" : "reading-twillot",
					lastSuccessAt: Date.now(),
					lastError: null,
				});
				await chrome.alarms.create(CLAIM_ALARM, { when: Date.now() + 1_000 });
				return { ok: true, accepted: true, finished: outbox.body.done };
			} catch (error) {
				if (isStaleLeaseError(error)) {
					await discardStaleLease(outbox.body.jobId);
					return { ok: true, staleLease: true };
				}
				if (isPermanentJobError(error)) {
					const job = await getStored(STORAGE.activeJob);
					if (validJob(job) && job.id === outbox.body.jobId) {
						await reportJobError(job, error);
						await chrome.storage.local.remove(STORAGE.activeJob);
					}
					const current = await getStored(STORAGE.outbox);
					if (current?.batchId === outbox.batchId) {
						await chrome.storage.local.remove(STORAGE.outbox);
					}
					await removeMatchingCapture(outbox.body.jobId);
					await mergeStatus({
						state: "schema-blocked",
						lastError: controlledError(error),
					});
					return { ok: false, permanent: true, error: controlledError(error) };
				}
				const current = await getStored(STORAGE.outbox);
				if (current?.batchId === outbox.batchId) {
					const attempts = Number.isSafeInteger(outbox.attempts)
						? outbox.attempts + 1
						: 1;
					const nextAttemptAt = Date.now() + outboxRetryDelay(attempts);
					await setStored(STORAGE.outbox, {
						...outbox,
						attempts,
						nextAttemptAt,
					});
					await chrome.alarms.create(RETRY_ALARM, { when: nextAttemptAt });
				}
				await mergeStatus({
					state: "retrying",
					lastError: controlledError(error),
				});
				return { ok: false, queued: true, error: controlledError(error) };
			}
		})().finally(() => {
			activeFlush = null;
		});
		return activeFlush;
	}

	async function heartbeat(job, state) {
		await postAction({
			action: "heartbeat",
			jobId: job.id,
			leaseToken: job.leaseToken,
			status: state,
		});
	}

	async function reportJobError(job, error) {
		await postAction({
			action: "error",
			jobId: job.id,
			leaseToken: job.leaseToken,
			error: controlledError(error).slice(0, 300),
		}).catch(() => {});
	}

	async function scanActiveJob() {
		if (activeScan) return activeScan;
		activeScan = (async () => {
			if (await getStored(STORAGE.outbox)) return flushOutbox();
			const job = await getStored(STORAGE.activeJob);
			if (!validJob(job)) return claimNextJob();
			let database;
			try {
				database = await openExistingDatabase();
				assertSchema(database);
				const syncSettings = await readSyncSettings(
					database,
					job.externalUserId,
				);
				let capture = await getJobCapture(job);
				if (!capture) {
					capture = baselineCapture(job, syncSettings);
					await saveJobCapture(capture);
					await ensureJobTab(job, true);
					await mergeStatus({ state: "waiting-for-twillot", lastError: null });
					await heartbeat(job, "waiting_for_twillot");
					return { ok: true, waiting: true, baselineCaptured: true };
				}
				const baselineWasPending = !capture.baselineCaptured;
				const freshness = evaluateFreshness(capture, syncSettings);
				capture = freshness.capture;
				await saveJobCapture(capture);
				if (baselineWasPending) {
					await ensureJobTab(job, true);
					await mergeStatus({ state: "waiting-for-twillot", lastError: null });
					await heartbeat(job, "waiting_for_twillot");
					return { ok: true, waiting: true, baselineCaptured: true };
				}
				if (!freshness.ready) {
					await mergeStatus({ state: "waiting-for-twillot", lastError: null });
					if (typeof capture.stableSince === "number") {
						await chrome.alarms.create(CLAIM_ALARM, {
							when: capture.stableSince + FRESHNESS_STABLE_MS,
						});
					}
					await heartbeat(job, "waiting_for_twillot");
					return { ok: true, waiting: true };
				}
				const batch = await readPostBatch(database, job, syncSettings);
				const done = !batch.hasMore;
				const batchId = await stableBatchId(
					job,
					batch.records,
					batch.cursor,
					done,
				);
				const body = {
					action: "batch",
					protocolVersion: PROTOCOL_VERSION,
					jobId: job.id,
					leaseToken: job.leaseToken,
					batchId,
					records: batch.records,
					cursor: batch.cursor,
					done,
					lastSyncTime: freshness.lastSyncTime,
				};
				if (body.records.length > MAX_BATCH_RECORDS) {
					throw new PermanentCaptureError(
						"The Twillot batch exceeds the record limit.",
					);
				}
				const encoded = JSON.stringify(body);
				if (new TextEncoder().encode(encoded).byteLength > MAX_BODY_BYTES) {
					throw new PermanentCaptureError(
						"The Twillot batch exceeds the upload limit.",
					);
				}
				await setStored(STORAGE.outbox, {
					batchId,
					body,
					attempts: 0,
					queuedAt: Date.now(),
				});
				return flushOutbox();
			} catch (error) {
				if (isStaleLeaseError(error)) {
					await discardStaleLease(job.id);
					return { ok: true, staleLease: true };
				}
				if (error instanceof PermanentCaptureError) {
					await mergeStatus({
						state: "schema-blocked",
						lastError: controlledError(error),
					});
					await reportJobError(job, error);
					await chrome.storage.local.remove(STORAGE.activeJob);
					await removeMatchingCapture(job.id);
					await chrome.alarms.create(CLAIM_ALARM, {
						when: Date.now() + RETRY_BASE_MS,
					});
					return { ok: false, permanent: true, error: controlledError(error) };
				}
				await mergeStatus({
					state: "retrying",
					lastError: controlledError(error),
				});
				await heartbeat(job, "waiting_for_twillot").catch(() => {});
				await chrome.alarms.create(RETRY_ALARM, {
					when: Date.now() + RETRY_BASE_MS,
				});
				return { ok: false, error: controlledError(error) };
			} finally {
				database?.close();
			}
		})().finally(() => {
			activeScan = null;
		});
		return activeScan;
	}

	async function getPublicState() {
		const [settings, job, outbox, status] = await Promise.all([
			readSettings(),
			getStored(STORAGE.activeJob),
			getStored(STORAGE.outbox),
			getStored(STORAGE.status),
		]);
		return {
			endpoint: settings.endpoint,
			tokenConfigured: Boolean(settings.token),
			activeJob: validJob(job)
				? { id: job.id, handle: job.handle, externalUserId: job.externalUserId }
				: null,
			pendingBatch: Boolean(outbox?.batchId),
			status: { ...DEFAULT_STATUS, ...status },
		};
	}

	async function saveSettings(endpoint, token) {
		const current = await readSettings();
		const nextEndpoint = normalizeEndpoint(endpoint);
		const nextToken = token ? String(token) : current.token;
		if (!validToken(nextToken))
			throw new CompanionError("Enter a valid BirdClaw pairing token.");
		if (
			nextEndpoint !== current.endpoint &&
			(await getStored(STORAGE.outbox))
		) {
			throw new CompanionError(
				"Wait for the saved Twillot batch before changing the endpoint.",
			);
		}
		await setStored(STORAGE.settings, {
			endpoint: nextEndpoint,
			token: nextToken,
		});
		await mergeStatus({ state: "configured", lastError: null });
		return claimNextJob();
	}

	function trustedPage(sender) {
		return isTwillotExportUrl(sender?.url || sender?.tab?.url || "");
	}

	function handleMessage(message, sender) {
		if (!message || typeof message !== "object")
			return Promise.resolve({ ok: false, error: "Invalid request." });
		if (message.type === CONTROL.getState) {
			return getPublicState().then((state) => ({ ok: true, state }));
		}
		if (message.type === CONTROL.saveSettings) {
			return serialize(() =>
				saveSettings(message.endpoint, message.token),
			).then(() => ({ ok: true }));
		}
		if (message.type === CONTROL.syncNow) {
			return serialize(async () => {
				const flushed = await flushOutbox();
				if (!flushed.ok && !flushed.empty) return flushed;
				return scanActiveJob();
			});
		}
		if (message.type === CONTROL.openOptions && trustedPage(sender)) {
			return chrome.runtime.openOptionsPage().then(() => ({ ok: true }));
		}
		if (!trustedPage(sender))
			return Promise.resolve({ ok: false, error: "Untrusted page." });
		if (message.type === CONTROL.getActiveJob) {
			return getStored(STORAGE.activeJob).then((job) => ({
				ok: true,
				job:
					validJob(job) && pageMatchesJob(message.publicUid, job)
						? {
								id: job.id,
								handle: job.handle,
								externalUserId: job.externalUserId,
							}
						: null,
			}));
		}
		if (message.type === CONTROL.pageOpened) {
			return serialize(async () => {
				const job = await getStored(STORAGE.activeJob);
				if (validJob(job) && !pageMatchesJob(message.publicUid, job)) {
					return { ok: true, ignored: true };
				}
				return scanActiveJob();
			});
		}
		return Promise.resolve({ ok: false, error: "Unknown request." });
	}

	chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
		handleMessage(message, sender)
			.then(sendResponse)
			.catch((error) =>
				sendResponse({ ok: false, error: controlledError(error) }),
			);
		return true;
	});
	chrome.alarms.onAlarm.addListener((alarm) => {
		if (alarm.name === RETRY_ALARM || alarm.name === CLAIM_ALARM) {
			void serialize(async () => {
				const flushed = await flushOutbox();
				if (flushed.ok && flushed.empty) await scanActiveJob();
			});
		}
	});
	async function installAlarms() {
		await chrome.alarms.create(CLAIM_ALARM, {
			periodInMinutes: CLAIM_INTERVAL_MINUTES,
		});
		await chrome.alarms.create(RETRY_ALARM, {
			periodInMinutes: RETRY_INTERVAL_MINUTES,
		});
	}
	chrome.runtime.onInstalled.addListener(() => void installAlarms());
	chrome.runtime.onStartup.addListener(
		() => void installAlarms().then(() => serialize(() => flushOutbox())),
	);
	void installAlarms();

	Object.defineProperty(globalThis, "__BIRDCLAW_TWILLOT_CLOUD__", {
		configurable: false,
		writable: false,
		value: Object.freeze({
			getState: () => handleMessage({ type: CONTROL.getState }, {}),
			syncNow: () => handleMessage({ type: CONTROL.syncNow }, {}),
		}),
	});

	if (globalThis.__BIRDCLAW_TWILLOT_TEST__) {
		globalThis.__birdclawTwillotWorkerTest = {
			CONTROL,
			STORAGE,
			assertSchema,
			baselineCapture,
			claimNextJob,
			checkpointEqual,
			evaluateFreshness,
			flushOutbox,
			handleMessage,
			jsonSafe,
			normalizeEndpoint,
			outboxRetryDelay,
			pageMatchesJob,
			projectPostRecord,
			projectQuotedPost,
			readPostBatch,
			readSyncSettings,
			scanActiveJob,
			stableBatchId,
			validJob,
		};
	}
})();
