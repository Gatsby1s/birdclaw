// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorialFeedScheduler } from "./editorial-feed-scheduler";

afterEach(() => {
	vi.useRealTimers();
});

describe("editorial feed scheduler", () => {
	it("runs one lane per source interval, stops cleanly, and can restart", async () => {
		vi.useFakeTimers();
		const sync = vi.fn(async (kind: "flash" | "article") => ({
			kind,
			seen: 0,
			changed: 0,
		}));
		const scheduler = new EditorialFeedScheduler({
			sync,
			initialDelayMs: 0,
			intervals: { flash: 1_000, article: 1_000 },
		});

		scheduler.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(sync).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(sync).toHaveBeenCalledTimes(4);

		scheduler.stop();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(sync).toHaveBeenCalledTimes(4);

		scheduler.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(sync).toHaveBeenCalledTimes(6);
		scheduler.stop();
	});

	it("does not let a stopped run schedule work into a restarted lane", async () => {
		vi.useFakeTimers();
		const pending: Array<{
			kind: "flash" | "article";
			resolve: () => void;
		}> = [];
		const sync = vi.fn(
			(kind: "flash" | "article") =>
				new Promise<{
					kind: "flash" | "article";
					seen: number;
					changed: number;
				}>((resolve) => {
					pending.push({
						kind,
						resolve: () => resolve({ kind, seen: 0, changed: 0 }),
					});
				}),
		);
		const scheduler = new EditorialFeedScheduler({
			sync,
			initialDelayMs: 0,
			intervals: { flash: 1_000, article: 1_000 },
		});

		scheduler.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(sync).toHaveBeenCalledTimes(2);
		scheduler.stop();
		scheduler.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(sync).toHaveBeenCalledTimes(4);

		for (const run of pending.slice(0, 2)) run.resolve();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(sync).toHaveBeenCalledTimes(4);

		for (const run of pending.slice(2, 4)) run.resolve();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(sync).toHaveBeenCalledTimes(6);
		scheduler.stop();
	});
});
