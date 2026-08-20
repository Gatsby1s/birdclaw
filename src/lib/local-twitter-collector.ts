import {
	listThreadViaBird,
	listUserTweetsViaBird,
	searchTweetsViaBird,
} from "./bird";
import { enqueueDatabaseWrite } from "./database-writer";
import { getNativeDb } from "./db";
import { syncHomeTimeline } from "./timeline-live";
import { ingestTweetPayload } from "./tweet-repository";
import type { XurlMentionsResponse } from "./types";

const DEFAULT_INTERVAL_SECONDS = 2 * 60;
const DEFAULT_MAX_RESULTS = 100;
const DEFAULT_STARTUP_MAX_RESULTS = 600;
const DEFAULT_MAX_PAGES = 3;
const FRESHNESS_MULTIPLIER = 1.5;

export interface LocalTwitterCollectorStatus {
	enabled: boolean;
	running: boolean;
	lastSuccessAt: string | null;
	timelineEnabled: boolean;
	lastTimelineSuccessAt: string | null;
	lastError: string | null;
	ingestedCount: number;
	intervalSeconds: number;
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

function positiveNumber(value: string | undefined, fallback: number) {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function localCollectorConfig() {
	return {
		enabled: process.env.BIRDCLAW_LOCAL_COLLECTOR_ENABLED === "1",
		timelineEnabled:
			process.env.BIRDCLAW_LOCAL_COLLECTOR_HOME_TIMELINE_ENABLED === "1",
		watchUsers: listEnv(
			process.env.BIRDCLAW_LOCAL_COLLECTOR_WATCH_USERS ??
				process.env.BIRDCLAW_6551_WATCH_USERS,
		),
		targetTweetIds: listEnv(
			process.env.BIRDCLAW_LOCAL_COLLECTOR_TARGET_TWEETS ??
				process.env.BIRDCLAW_6551_TARGET_TWEETS,
		),
		accountId: process.env.BIRDCLAW_LOCAL_COLLECTOR_ACCOUNT_ID?.trim() || "",
		intervalSeconds: positiveNumber(
			process.env.BIRDCLAW_LOCAL_COLLECTOR_INTERVAL_SECONDS,
			DEFAULT_INTERVAL_SECONDS,
		),
		maxResults: positiveNumber(
			process.env.BIRDCLAW_LOCAL_COLLECTOR_MAX_RESULTS,
			DEFAULT_MAX_RESULTS,
		),
		startupMaxResults: positiveNumber(
			process.env.BIRDCLAW_LOCAL_COLLECTOR_STARTUP_MAX_RESULTS,
			DEFAULT_STARTUP_MAX_RESULTS,
		),
		maxPages: positiveNumber(
			process.env.BIRDCLAW_LOCAL_COLLECTOR_MAX_PAGES,
			DEFAULT_MAX_PAGES,
		),
	};
}

function resolveCollectorAccountId(preferred: string) {
	const db = getNativeDb({ seedDemoData: false });
	if (preferred) {
		const row = db
			.prepare("select id from accounts where id = ?")
			.get(preferred) as { id?: string } | undefined;
		if (row?.id) return row.id;
	}
	const row = db
		.prepare(
			"select id from accounts order by is_default desc, created_at asc limit 1",
		)
		.get() as { id?: string } | undefined;
	if (!row?.id) {
		throw new Error("Local Twitter collector has no BirdClaw account");
	}
	return row.id;
}

export function resolveLocalTwitterCollectorAccountId() {
	return resolveCollectorAccountId(localCollectorConfig().accountId);
}

async function ingestCollectorPayload(
	accountId: string,
	payload: XurlMentionsResponse,
) {
	return enqueueDatabaseWrite((db) =>
		ingestTweetPayload(db, {
			accountId,
			payload,
			source: "bird",
			edgeKind: "home",
			markRepliesAsReplied: false,
		}),
	);
}

export class LocalTwitterCollector {
	private timer: ReturnType<typeof setInterval> | null = null;
	private stopped = false;
	private running = false;
	private initialTimelineSyncPending = true;
	private readonly config = localCollectorConfig();
	private status: LocalTwitterCollectorStatus = {
		enabled: this.config.enabled,
		running: false,
		lastSuccessAt: null,
		timelineEnabled: this.config.timelineEnabled,
		lastTimelineSuccessAt: null,
		lastError: null,
		ingestedCount: 0,
		intervalSeconds: this.config.intervalSeconds,
	};

	start() {
		if (!this.config.enabled || this.stopped || this.timer) return;
		void this.runOnce();
		this.timer = setInterval(
			() => void this.runOnce(),
			this.config.intervalSeconds * 1000,
		);
		this.timer.unref?.();
	}

	stop() {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	getStatus() {
		return { ...this.status };
	}

	isFresh(now = new Date()) {
		if (!this.config.enabled) return false;
		const requiredSuccessAt = this.config.timelineEnabled
			? this.status.lastTimelineSuccessAt
			: this.status.lastSuccessAt;
		return Boolean(
			requiredSuccessAt &&
			now.getTime() - new Date(requiredSuccessAt).getTime() <=
				this.config.intervalSeconds * FRESHNESS_MULTIPLIER * 1000,
		);
	}

	async runOnce() {
		if (!this.config.enabled || this.stopped || this.running) {
			return this.getStatus();
		}
		this.running = true;
		this.status = { ...this.status, running: true };
		try {
			const accountId = resolveCollectorAccountId(this.config.accountId);
			const errors: string[] = [];
			let ingested = 0;
			if (this.config.timelineEnabled) {
				try {
					const timelineLimit = this.initialTimelineSyncPending
						? Math.max(this.config.maxResults, this.config.startupMaxResults)
						: this.config.maxResults;
					const result = await syncHomeTimeline({
						account: accountId,
						mode: "bird",
						limit: timelineLimit,
						following: true,
						refresh: true,
					});
					this.initialTimelineSyncPending = false;
					ingested += result.count;
					this.status = {
						...this.status,
						lastTimelineSuccessAt: new Date().toISOString(),
					};
				} catch (error) {
					errors.push(`Home timeline sync failed: ${errorMessage(error)}`);
				}
			}
			const payloads: XurlMentionsResponse[] = [];
			for (const username of this.config.watchUsers) {
				try {
					payloads.push(
						await listUserTweetsViaBird({
							username,
							maxResults: this.config.maxResults,
							maxPages: this.config.maxPages,
						}),
					);
				} catch (error) {
					errors.push(
						`Watched user @${username} sync failed: ${errorMessage(error)}`,
					);
				}
			}
			for (const tweetId of this.config.targetTweetIds) {
				try {
					payloads.push(
						await listThreadViaBird({
							tweetId,
							all: true,
							maxPages: this.config.maxPages,
							timeoutMs: 60_000,
						}),
					);
					payloads.push(
						await searchTweetsViaBird(`quoted_tweet_id:${tweetId}`, {
							maxResults: this.config.maxResults,
							all: true,
							maxPages: this.config.maxPages,
						}),
					);
				} catch (error) {
					errors.push(
						`Target tweet ${tweetId} sync failed: ${errorMessage(error)}`,
					);
				}
			}
			if (
				!this.config.timelineEnabled &&
				this.config.watchUsers.length === 0 &&
				this.config.targetTweetIds.length === 0
			) {
				throw new Error("Local Twitter collector has no configured targets");
			}
			for (const payload of payloads) {
				try {
					ingested += (await ingestCollectorPayload(accountId, payload)).length;
				} catch (error) {
					errors.push(`Collector ingest failed: ${errorMessage(error)}`);
				}
			}
			this.status = {
				...this.status,
				ingestedCount: this.status.ingestedCount + ingested,
			};
			if (errors.length > 0) {
				throw new Error(errors.join("; "));
			}
			this.status = {
				...this.status,
				lastSuccessAt: new Date().toISOString(),
				lastError: null,
			};
		} catch (error) {
			this.status = { ...this.status, lastError: errorMessage(error) };
		} finally {
			this.running = false;
			this.status = { ...this.status, running: false };
		}
		return this.getStatus();
	}
}

let activeCollector: LocalTwitterCollector | null = null;

export function getLocalTwitterCollectorStatus() {
	return (
		activeCollector?.getStatus() ?? {
			enabled: false,
			running: false,
			lastSuccessAt: null,
			timelineEnabled: false,
			lastTimelineSuccessAt: null,
			lastError: null,
			ingestedCount: 0,
			intervalSeconds: DEFAULT_INTERVAL_SECONDS,
		}
	);
}

export function isLocalTwitterCollectorFresh() {
	return activeCollector?.isFresh() ?? false;
}

export function startLocalTwitterCollector() {
	if (activeCollector) return activeCollector;
	const collector = new LocalTwitterCollector();
	activeCollector = collector;
	collector.start();
	return collector;
}

export function stopLocalTwitterCollector() {
	activeCollector?.stop();
	activeCollector = null;
}
