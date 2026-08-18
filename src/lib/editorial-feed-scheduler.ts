import type { FeedItemKind } from "./api-contracts";
import { syncTigerFeed, type FeedSyncResult } from "./editorial-feed";

const DEFAULT_INTERVALS: Record<FeedItemKind, number> = {
	flash: 60_000,
	article: 5 * 60_000,
};
const MAX_BACKOFF_MS = 15 * 60_000;

interface SchedulerLane {
	timer: ReturnType<typeof setTimeout> | null;
	failures: number;
}

export class EditorialFeedScheduler {
	private readonly lanes: Record<FeedItemKind, SchedulerLane> = {
		flash: { timer: null, failures: 0 },
		article: { timer: null, failures: 0 },
	};
	private abortController = new AbortController();
	private started = false;

	constructor(
		private readonly options: {
			sync?: (
				kind: FeedItemKind,
				signal: AbortSignal,
			) => Promise<FeedSyncResult>;
			intervals?: Partial<Record<FeedItemKind, number>>;
			initialDelayMs?: number;
		} = {},
	) {}

	start() {
		if (this.started) return;
		if (this.abortController.signal.aborted) {
			this.abortController = new AbortController();
		}
		this.started = true;
		for (const kind of ["flash", "article"] as const) {
			this.schedule(kind, Math.max(0, this.options.initialDelayMs ?? 1_000));
		}
	}

	stop() {
		if (!this.started) return;
		this.started = false;
		this.abortController.abort(new Error("Editorial feed scheduler stopped"));
		for (const lane of Object.values(this.lanes)) {
			if (lane.timer) clearTimeout(lane.timer);
			lane.timer = null;
		}
	}

	private schedule(kind: FeedItemKind, delayMs: number) {
		if (!this.started || this.abortController.signal.aborted) return;
		const lane = this.lanes[kind];
		if (lane.timer) clearTimeout(lane.timer);
		lane.timer = setTimeout(() => {
			lane.timer = null;
			void this.run(kind);
		}, delayMs);
	}

	private async run(kind: FeedItemKind) {
		if (!this.started || this.abortController.signal.aborted) return;
		const lane = this.lanes[kind];
		const signal = this.abortController.signal;
		const interval = Math.max(
			1_000,
			this.options.intervals?.[kind] ?? DEFAULT_INTERVALS[kind],
		);
		try {
			await (
				this.options.sync ??
				((nextKind, nextSignal) =>
					syncTigerFeed(nextKind, { signal: nextSignal }))
			)(kind, signal);
			if (
				!this.started ||
				signal.aborted ||
				signal !== this.abortController.signal
			) {
				return;
			}
			lane.failures = 0;
			this.schedule(kind, interval);
		} catch {
			if (
				!this.started ||
				signal.aborted ||
				signal !== this.abortController.signal
			) {
				return;
			}
			lane.failures += 1;
			const backoff = Math.min(
				MAX_BACKOFF_MS,
				interval * 2 ** Math.min(4, lane.failures),
			);
			this.schedule(kind, backoff);
		}
	}
}

let activeScheduler: EditorialFeedScheduler | null = null;

function feedSchedulerEnabled() {
	const value =
		process.env.BIRDCLAW_EDITORIAL_FEED_ENABLED?.trim().toLowerCase();
	return value !== "0" && value !== "false" && value !== "off";
}

export function startEditorialFeedScheduler() {
	if (!feedSchedulerEnabled() || activeScheduler) return;
	activeScheduler = new EditorialFeedScheduler();
	activeScheduler.start();
}

export function stopEditorialFeedScheduler() {
	activeScheduler?.stop();
	activeScheduler = null;
}

export const __test__ = {
	feedSchedulerEnabled,
};
