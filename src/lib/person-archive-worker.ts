import { getNativeDb } from "./db";
import {
	enqueuePersonAsset,
	ensureFollowedPeople,
	queuePersonXSource,
	recordPersonEvent,
	upsertPersonDocument,
} from "./person-archive-store";
import { runPersonMediaBatch } from "./person-media";
import type { Database } from "./sqlite";
import {
	allowedPersonMediaUrl,
	fetchTelegramChannelPage,
	type TelegramChannelPage,
	type TelegramPublicPost,
} from "./telegram-channel";

type SourceRow = {
	id: string;
	person_id: string;
	kind: "x" | "telegram";
	identifier: string;
	profile_id: string | null;
	enabled: number;
	history_status: string;
	history_cursor: string | null;
	latest_cursor: string | null;
	media_cursor: number;
	created_at: string;
};
type LatestCursor = { latest: number; before?: number; target?: number };
type WorkerOptions = {
	db?: Database;
	now?: Date;
	fetchPage?: typeof fetchTelegramChannelPage;
	fetchImpl?: typeof fetch;
	rootDir?: string;
	skipMedia?: boolean;
};

function positiveId(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? value
		: undefined;
}
function latestCursor(raw: string | null): LatestCursor | null {
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed === "number")
			return Number.isSafeInteger(parsed) && parsed >= 0
				? { latest: parsed }
				: null;
		if (!parsed || typeof parsed !== "object") return null;
		const cursor = parsed as Record<string, unknown>;
		if (
			typeof cursor.latest !== "number" ||
			!Number.isSafeInteger(cursor.latest) ||
			cursor.latest < 0
		)
			return null;
		return {
			latest: Number(cursor.latest),
			before: positiveId(cursor.before),
			target: positiveId(cursor.target),
		};
	} catch {
		throw new Error("Telegram incremental cursor is invalid");
	}
}
function historyCursor(raw: string | null) {
	if (!raw) return undefined;
	try {
		const cursor: unknown = JSON.parse(raw);
		const id =
			typeof cursor === "object" && cursor !== null
				? (cursor as Record<string, unknown>).before
				: cursor;
		if (!positiveId(id)) throw new Error("Invalid cursor");
		return Number(id);
	} catch {
		throw new Error("Telegram history cursor is invalid");
	}
}
function shortError(error: unknown) {
	// Never include request URLs, signed CDN tokens, or session data in persisted errors.
	return (error instanceof Error ? error.message : "Collection failed")
		.replace(/https?:\/\/\S+/g, "[remote URL]")
		.slice(0, 300);
}

function storeTelegramPosts(
	db: Database,
	source: SourceRow,
	posts: TelegramPublicPost[],
	historical: boolean,
) {
	for (const post of posts) {
		const result = upsertPersonDocument(db, {
			personId: source.person_id,
			sourceId: source.id,
			externalId: String(post.id),
			kind: "telegram",
			title: `Telegram · ${source.identifier} · ${post.id}`,
			text: post.text,
			publishedAt: post.publishedAt,
			sourceUrl: post.url,
			isHistorical: historical,
			extractionStatus: post.textUnavailable
				? "unavailable"
				: post.text
					? "indexed"
					: "media_only",
			rawJson: {
				coverage: "public_web",
				forwardedFrom: post.forwardedFrom,
				attribution: post.forwardedFrom ? "forwarded" : "channel",
				media: post.media,
				unsupportedMedia: post.unsupportedMedia,
				textUnavailable: post.textUnavailable,
			},
		});
		for (const media of post.media) {
			// Telegram refreshes signed download query strings. Keep one asset per
			// document/CDN file path, while allowing a failed link to be refreshed.
			const existing = db
				.prepare(
					"select id,remote_url,status from person_assets where source_id=? and document_id=?",
				)
				.all(source.id, result.id) as Array<{
				id: string;
				remote_url: string;
				status: string;
			}>;
			const previous = existing.find((asset) => {
				try {
					const old = new URL(asset.remote_url);
					const current = new URL(media.url);
					return (
						old.hostname === current.hostname &&
						old.pathname === current.pathname
					);
				} catch {
					return false;
				}
			});
			if (previous) {
				if (previous.remote_url !== media.url && previous.status !== "stored")
					db.prepare(
						"update person_assets set remote_url=?,status='pending',attempts=0,last_error=null,next_attempt_at=? where id=?",
					).run(media.url, new Date().toISOString(), previous.id);
				continue;
			}
			enqueuePersonAsset(db, {
				personId: source.person_id,
				sourceId: source.id,
				documentId: result.id,
				remoteUrl: media.url,
				kind: media.kind,
			});
		}
	}
}

function validatePageProgress(page: TelegramChannelPage, before?: number) {
	if (
		before &&
		(page.posts.some((post) => post.id >= before) ||
			(page.before !== null && page.before >= before))
	)
		throw new Error(
			"Telegram history pagination did not advance; retry requires attention",
		);
}

export async function collectPersonTelegramSource(
	db: Database,
	source: SourceRow,
	options: WorkerOptions = {},
) {
	const now = options.now ?? new Date();
	const fetchPage = options.fetchPage ?? fetchTelegramChannelPage;
	let latest = latestCursor(source.latest_cursor);
	let before = historyCursor(source.history_cursor);
	let status = source.history_status;
	let restartedPage: TelegramChannelPage | undefined;
	const stillEnabled = () =>
		Boolean(
			(
				db
					.prepare("select enabled from person_sources where id=?")
					.get(source.id) as { enabled: number } | undefined
			)?.enabled,
		);
	if (latest && status === "queued") {
		restartedPage = await fetchPage(source.identifier, {
			fetchImpl: options.fetchImpl,
		});
		if (!stillEnabled()) return;
		const page = restartedPage;
		db.transaction(() => {
			storeTelegramPosts(db, source, page.posts, true);
			before = page.before ?? undefined;
			status = before ? "backfilling" : "public_caught_up";
			db.prepare(
				"update person_sources set history_cursor=?,history_status=? where id=?",
			).run(before ? JSON.stringify({ before }) : null, status, source.id);
		})();
	}
	if (!latest) {
		const page = await fetchPage(source.identifier, {
			fetchImpl: options.fetchImpl,
		});
		if (!stillEnabled()) return;
		const maximum = page.posts.at(-1)?.id;
		db.transaction(() => {
			storeTelegramPosts(db, source, page.posts, true);
			latest = { latest: maximum ?? 0 };
			before = page.before ?? undefined;
			status = before ? "backfilling" : "public_caught_up";
			db.prepare(
				"update person_sources set latest_cursor=?,history_cursor=?,history_status=? where id=?",
			).run(
				latest ? JSON.stringify(latest) : null,
				before ? JSON.stringify({ before }) : null,
				status,
				source.id,
			);
		})();
	} else {
		const current: LatestCursor = latest;
		const page =
			!current.before && restartedPage
				? restartedPage
				: await fetchPage(source.identifier, {
						before: current.before,
						fetchImpl: options.fetchImpl,
					});
		if (!stillEnabled()) return;
		validatePageProgress(page, current.before);
		const target = Math.max(
			current.target ?? current.latest,
			page.posts.at(-1)?.id ?? current.latest,
		);
		const oldest = page.posts[0]?.id;
		const pending =
			page.before !== null && oldest !== undefined && oldest > current.latest;
		const next: LatestCursor = pending
			? { latest: current.latest, before: page.before!, target }
			: { latest: target };
		db.transaction(() => {
			// Re-observed messages are also upserted so edits and refreshed CDN URLs propagate.
			storeTelegramPosts(db, source, page.posts, true);
			for (const post of page.posts.filter(
				(post) => post.id > current.latest,
			)) {
				if (post.publishedAt >= source.created_at) {
					const doc = db
						.prepare(
							"select id from person_documents where source_id=? and external_id=?",
						)
						.get(source.id, String(post.id)) as { id: string } | undefined;
					if (doc)
						recordPersonEvent(
							db,
							source.person_id,
							`doc:${doc.id}`,
							now.toISOString(),
						);
				}
			}
			db.prepare("update person_sources set latest_cursor=? where id=?").run(
				JSON.stringify(next),
				source.id,
			);
		})();
		latest = next;
		if (before) {
			const history = await fetchPage(source.identifier, {
				before,
				fetchImpl: options.fetchImpl,
			});
			if (!stillEnabled()) return;
			validatePageProgress(history, before);
			db.transaction(() => {
				storeTelegramPosts(db, source, history.posts, true);
				before = history.before ?? undefined;
				status = before ? "backfilling" : "public_caught_up";
				db.prepare(
					"update person_sources set history_cursor=?,history_status=? where id=?",
				).run(before ? JSON.stringify({ before }) : null, status, source.id);
			})();
		}
	}
	const activeHistory = Boolean(
		before || (latest as LatestCursor | null)?.before,
	);
	db.prepare(
		"update person_sources set history_status=?,last_synced_at=?,last_error=null,next_poll_at=? where id=?",
	).run(
		status,
		now.toISOString(),
		new Date(now.getTime() + (activeHistory ? 30_000 : 45_000)).toISOString(),
		source.id,
	);
}

function mediaFromTweet(raw: string) {
	let media: unknown;
	try {
		media = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(media)) return [];
	const found: Array<{ kind: string; url: string }> = [];
	for (const candidate of media) {
		if (!candidate || typeof candidate !== "object") continue;
		const item = candidate as Record<string, unknown>;
		if (typeof item.url === "string" && allowedPersonMediaUrl(item.url))
			found.push({
				kind: item.type === "photo" ? "image" : String(item.type ?? "image"),
				url: item.url,
			});
		const videoInfo =
			item.video_info && typeof item.video_info === "object"
				? (item.video_info as Record<string, unknown>)
				: {};
		const variants = Array.isArray(item.variants)
			? item.variants
			: Array.isArray(videoInfo.variants)
				? videoInfo.variants
				: [];
		const videos = variants
			.filter(
				(
					variant,
				): variant is {
					url: string;
					bit_rate?: number;
					bitrate?: number;
					bitRate?: number;
				} =>
					variant &&
					typeof variant === "object" &&
					typeof variant.url === "string" &&
					allowedPersonMediaUrl(variant.url) &&
					(variant.content_type === "video/mp4" ||
						variant.contentType === "video/mp4" ||
						/\.mp4(?:\?|$)/.test(variant.url)),
			)
			.sort(
				(a, b) =>
					Number(b.bitRate ?? b.bit_rate ?? b.bitrate ?? 0) -
					Number(a.bitRate ?? a.bit_rate ?? a.bitrate ?? 0),
			);
		if (videos[0])
			found.push({
				kind: item.type === "animated_gif" ? "gif" : "video",
				url: videos[0].url,
			});
	}
	return found;
}

async function collectPersonXSource(
	db: Database,
	source: SourceRow,
	now: Date,
) {
	if (source.history_status === "queued" || !source.profile_id) {
		await queuePersonXSource(db, source.id);
		const refreshed = db
			.prepare("select * from person_sources where id=?")
			.get(source.id) as SourceRow | undefined;
		if (!refreshed?.profile_id || !refreshed.enabled) return;
		source = refreshed;
	}
	type TweetRow = {
		row_id: number;
		id: string;
		media_json: string;
		created_at: string;
	};
	const rows = db
		.prepare(
			"select rowid as row_id,id,media_json,created_at from tweets where author_profile_id=? and rowid>? and (? <> 'existing_archive' or created_at>=?) order by rowid limit 200",
		)
		.all(
			source.profile_id,
			source.media_cursor,
			source.history_status,
			source.created_at,
		) as TweetRow[];
	const recent = db
		.prepare(
			"select rowid as row_id,id,media_json,created_at from tweets where author_profile_id=? and (? <> 'existing_archive' or created_at>=?) order by rowid desc limit 50",
		)
		.all(
			source.profile_id,
			source.history_status,
			source.created_at,
		) as TweetRow[];
	db.transaction(() => {
		for (const tweet of new Map(
			[...rows, ...recent].map((row) => [row.id, row]),
		).values()) {
			for (const media of mediaFromTweet(tweet.media_json))
				enqueuePersonAsset(db, {
					personId: source.person_id,
					sourceId: source.id,
					tweetId: tweet.id,
					remoteUrl: media.url,
					kind: media.kind,
				});
			if (tweet.created_at >= source.created_at)
				recordPersonEvent(
					db,
					source.person_id,
					`tweet:${tweet.id}`,
					now.toISOString(),
				);
		}
		const job = db
			.prepare(
				"select capture_status from twillot_history_jobs where profile_id=? order by updated_at desc limit 1",
			)
			.get(source.profile_id) as { capture_status: string } | undefined;
		db.prepare(
			"update person_sources set media_cursor=?,history_status=?,last_synced_at=?,last_error=null,next_poll_at=? where id=?",
		).run(
			rows.at(-1)?.row_id ?? source.media_cursor,
			job?.capture_status ?? source.history_status,
			now.toISOString(),
			new Date(
				now.getTime() + (rows.length === 200 ? 30_000 : 120_000),
			).toISOString(),
			source.id,
		);
	})();
}

let running = false;
let mediaRunning = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let mediaTimer: ReturnType<typeof setTimeout> | null = null;
let mediaAbort: AbortController | null = null;
let enabled = false;
let generation = 0;

// X identities with a numeric profile are resolved without network access.
// Other initialized sources only need a bounded local tweet/media scan.
const LOCAL_X_SOURCE = `profile_id is not null and (history_status <> 'queued' or
  (substr(profile_id,1,13)='profile_user_' and length(profile_id)>13 and substr(profile_id,14) not glob '*[^0-9]*'))`;

export async function runPersonArchiveMediaOnce(options: WorkerOptions = {}) {
	if (mediaRunning || options.skipMedia)
		return { skipped: true, processed: 0, archived: 0 };
	mediaRunning = true;
	const controller = new AbortController();
	mediaAbort = controller;
	try {
		const result = await runPersonMediaBatch(
			options.db ?? getNativeDb({ seedDemoData: false }),
			{
				fetchImpl: options.fetchImpl,
				rootDir: options.rootDir,
				now: options.now,
				limit: 2,
				signal: controller.signal,
			},
		);
		return { skipped: false, ...result };
	} finally {
		if (mediaAbort === controller) mediaAbort = null;
		mediaRunning = false;
	}
}

export async function runPersonArchiveOnce(options: WorkerOptions = {}) {
	if (running) return { skipped: true, sources: 0 };
	running = true;
	try {
		const db = options.db ?? getNativeDb({ seedDemoData: false });
		const now = options.now ?? new Date();
		ensureFollowedPeople(db);
		const telegram = db
			.prepare(
				"select * from person_sources where enabled=1 and kind='telegram' and next_poll_at<=? order by next_poll_at,created_at,id limit 4",
			)
			.all(now.toISOString()) as SourceRow[];
		const localX = db
			.prepare(
				`select * from person_sources where enabled=1 and kind='x' and next_poll_at<=? and (${LOCAL_X_SOURCE}) order by next_poll_at,created_at,id limit 50`,
			)
			.all(now.toISOString()) as SourceRow[];
		const unresolvedX = db
			.prepare(
				`select * from person_sources where enabled=1 and kind='x' and next_poll_at<=? and not (${LOCAL_X_SOURCE}) order by next_poll_at,created_at,id limit 1`,
			)
			.all(now.toISOString()) as SourceRow[];
		const collect = async (source: SourceRow) => {
			try {
				if (source.kind === "telegram")
					await collectPersonTelegramSource(db, source, options);
				else await collectPersonXSource(db, source, now);
			} catch (error) {
				db.prepare(
					"update person_sources set last_error=?,next_poll_at=? where id=?",
				).run(
					shortError(error),
					new Date(now.getTime() + 5 * 60_000).toISOString(),
					source.id,
				);
			}
		};
		// Start the reserved channel requests first. Local X backlogs cannot
		// consume their slots, and one slow channel cannot block the other three.
		const remote = telegram.map(collect);
		for (const source of localX) await collect(source);
		remote.push(...unresolvedX.map(collect));
		await Promise.all(remote);
		if (!options.skipMedia) await runPersonArchiveMediaOnce(options);
		return {
			skipped: false,
			sources: telegram.length + localX.length + unresolvedX.length,
		};
	} finally {
		running = false;
	}
}
function scheduleNext(
	delay: number,
	options: WorkerOptions,
	currentGeneration: number,
) {
	if (!enabled || generation !== currentGeneration) return;
	timer = setTimeout(() => {
		timer = null;
		void runPersonArchiveOnce({ ...options, skipMedia: true })
			.catch(() => {
				console.error(
					"Person archive worker cycle failed; collection will retry",
				);
			})
			.finally(() => scheduleNext(15_000, options, currentGeneration));
	}, delay);
	timer.unref?.();
}
function scheduleMedia(
	delay: number,
	options: WorkerOptions,
	currentGeneration: number,
) {
	if (!enabled || generation !== currentGeneration || options.skipMedia) return;
	mediaTimer = setTimeout(() => {
		mediaTimer = null;
		void runPersonArchiveMediaOnce(options)
			.catch(() => {
				console.error("Person media worker cycle failed; archiving will retry");
			})
			.finally(() => scheduleMedia(15_000, options, currentGeneration));
	}, delay);
	mediaTimer.unref?.();
}
export function startPersonArchiveWorker(options: WorkerOptions = {}) {
	if (enabled || process.env.BIRDCLAW_PERSON_ARCHIVE_ENABLED === "0") return;
	enabled = true;
	generation++;
	scheduleNext(10_000, options, generation);
	scheduleMedia(15_000, options, generation);
}
export function stopPersonArchiveWorker() {
	enabled = false;
	generation++;
	if (timer) clearTimeout(timer);
	if (mediaTimer) clearTimeout(mediaTimer);
	mediaAbort?.abort();
	timer = null;
	mediaTimer = null;
}
