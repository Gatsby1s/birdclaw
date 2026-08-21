type ScheduledTask<T> = (signal: AbortSignal) => Promise<T>;

interface ScheduledEntry<T> {
	controller: AbortController | null;
	reject: (error: unknown) => void;
	resolve: (value: T) => void;
	running: boolean;
	settled: boolean;
	signals: readonly AbortSignal[];
	task: ScheduledTask<T>;
	onAbort: () => void;
}

interface SchedulerOptions {
	concurrency: number;
	cooldownMs?: number;
}

function abortError() {
	if (typeof DOMException !== "undefined") {
		return new DOMException("The request was cancelled", "AbortError");
	}
	const error = new Error("The request was cancelled");
	error.name = "AbortError";
	return error;
}

function overloadStatus(error: unknown) {
	if (!error || typeof error !== "object" || !("status" in error)) return null;
	const status = (error as { status?: unknown }).status;
	return status === 429 || status === 503 ? status : null;
}

/**
 * Bounds speculative timeline work shared by every mounted card. Tasks that
 * have not started are cheap to cancel, while running fetches receive a real
 * AbortSignal so leaving the viewport releases server work too.
 */
export class BoundedRequestScheduler {
	private activeCount = 0;
	private cooldownError: unknown = null;
	private cooldownUntil = 0;
	private readonly concurrency: number;
	private readonly cooldownMs: number;
	private readonly queue: Array<ScheduledEntry<unknown>> = [];
	private readonly running = new Set<ScheduledEntry<unknown>>();

	constructor({ concurrency, cooldownMs = 15_000 }: SchedulerOptions) {
		if (!Number.isInteger(concurrency) || concurrency < 1) {
			throw new Error(
				"Request scheduler concurrency must be a positive integer",
			);
		}
		this.concurrency = concurrency;
		this.cooldownMs = cooldownMs;
	}

	schedule<T>(
		task: ScheduledTask<T>,
		signals: readonly (AbortSignal | undefined)[] = [],
	): Promise<T> {
		const activeSignals = signals.filter(
			(signal): signal is AbortSignal => signal !== undefined,
		);
		if (activeSignals.some((signal) => signal.aborted)) {
			return Promise.reject(abortError());
		}
		if (this.cooldownUntil > Date.now()) {
			return Promise.reject(this.cooldownError);
		}
		this.cooldownError = null;
		this.cooldownUntil = 0;

		return new Promise<T>((resolve, reject) => {
			const entry: ScheduledEntry<T> = {
				controller: null,
				reject,
				resolve,
				running: false,
				settled: false,
				signals: activeSignals,
				task,
				onAbort: () => {
					entry.controller?.abort();
					if (!entry.running) {
						const index = this.queue.indexOf(entry as ScheduledEntry<unknown>);
						if (index >= 0) this.queue.splice(index, 1);
					}
					this.rejectEntry(entry as ScheduledEntry<unknown>, abortError());
				},
			};
			for (const signal of activeSignals) {
				signal.addEventListener("abort", entry.onAbort, { once: true });
			}
			this.queue.push(entry as ScheduledEntry<unknown>);
			this.drain();
		});
	}

	private cleanupEntry(entry: ScheduledEntry<unknown>) {
		for (const signal of entry.signals) {
			signal.removeEventListener("abort", entry.onAbort);
		}
	}

	private rejectEntry(entry: ScheduledEntry<unknown>, error: unknown) {
		if (entry.settled) return;
		entry.settled = true;
		this.cleanupEntry(entry);
		entry.reject(error);
	}

	private shedQueued(error: unknown) {
		for (const entry of this.queue.splice(0)) {
			this.rejectEntry(entry, error);
		}
	}

	private drain() {
		while (this.activeCount < this.concurrency) {
			const entry = this.queue.shift();
			if (!entry) return;
			if (entry.settled || entry.signals.some((signal) => signal.aborted)) {
				this.rejectEntry(entry, abortError());
				continue;
			}

			entry.running = true;
			entry.controller = new AbortController();
			this.activeCount += 1;
			this.running.add(entry);
			void Promise.resolve()
				.then(() =>
					entry.task(entry.controller?.signal ?? new AbortController().signal),
				)
				.then(
					(value) => {
						if (!entry.settled) {
							entry.settled = true;
							this.cleanupEntry(entry);
							entry.resolve(value);
						}
					},
					(error: unknown) => {
						if (overloadStatus(error) !== null) {
							this.cooldownError = error;
							this.cooldownUntil = Date.now() + this.cooldownMs;
							this.shedQueued(error);
						}
						this.rejectEntry(entry, error);
					},
				)
				.finally(() => {
					if (entry.running) {
						entry.running = false;
						this.running.delete(entry);
						this.activeCount -= 1;
						this.drain();
					}
				});
		}
	}

	resetForTests() {
		for (const entry of this.queue.splice(0)) {
			this.rejectEntry(entry, abortError());
		}
		for (const entry of this.running) {
			entry.controller?.abort();
			this.rejectEntry(entry, abortError());
			entry.running = false;
		}
		this.running.clear();
		this.activeCount = 0;
		this.cooldownError = null;
		this.cooldownUntil = 0;
	}
}

const timelineRequestScheduler = new BoundedRequestScheduler({
	concurrency: 4,
});

export function scheduleTimelineRequest<T>(
	task: ScheduledTask<T>,
	signals?: readonly (AbortSignal | undefined)[],
) {
	return timelineRequestScheduler.schedule(task, signals);
}

export const __test__ = {
	reset: () => timelineRequestScheduler.resetForTests(),
};
