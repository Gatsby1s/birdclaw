// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const birdMocks = vi.hoisted(() => ({
	listThread: vi.fn(),
	listUserTweets: vi.fn(),
	searchTweets: vi.fn(),
}));
const syncHomeTimelineMock = vi.hoisted(() => vi.fn());
const ingestTweetPayloadMock = vi.hoisted(() => vi.fn());

vi.mock("./bird", () => ({
	listThreadViaBird: (...args: unknown[]) => birdMocks.listThread(...args),
	listUserTweetsViaBird: (...args: unknown[]) =>
		birdMocks.listUserTweets(...args),
	searchTweetsViaBird: (...args: unknown[]) => birdMocks.searchTweets(...args),
}));

vi.mock("./database-writer", () => ({
	enqueueDatabaseWrite: (write: (db: unknown) => unknown) => write({}),
}));

vi.mock("./db", () => ({
	getNativeDb: () => ({
		prepare: () => ({ get: () => ({ id: "account:test" }) }),
	}),
}));

vi.mock("./timeline-live", () => ({
	syncHomeTimeline: (...args: unknown[]) => syncHomeTimelineMock(...args),
}));

vi.mock("./tweet-repository", () => ({
	ingestTweetPayload: (...args: unknown[]) => ingestTweetPayloadMock(...args),
}));

import { LocalTwitterCollector } from "./local-twitter-collector";

const environment = { ...process.env };
const emptyPayload = { data: [], includes: {}, meta: {} };

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((innerResolve) => {
		resolve = innerResolve;
	});
	return { promise, resolve };
}

function restoreEnvironment() {
	for (const key of Object.keys(process.env)) {
		if (!(key in environment)) delete process.env[key];
	}
	for (const [key, value] of Object.entries(environment)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

describe("local Twitter collector home timeline sync", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-09T12:00:00.000Z"));
		process.env.BIRDCLAW_LOCAL_COLLECTOR_ENABLED = "1";
		process.env.BIRDCLAW_LOCAL_COLLECTOR_HOME_TIMELINE_ENABLED = "1";
		process.env.BIRDCLAW_LOCAL_COLLECTOR_ACCOUNT_ID = "account:test";
		delete process.env.BIRDCLAW_LOCAL_COLLECTOR_WATCH_USERS;
		delete process.env.BIRDCLAW_LOCAL_COLLECTOR_TARGET_TWEETS;
		delete process.env.BIRDCLAW_6551_WATCH_USERS;
		delete process.env.BIRDCLAW_6551_TARGET_TWEETS;
		delete process.env.BIRDCLAW_LOCAL_COLLECTOR_INTERVAL_SECONDS;
		delete process.env.BIRDCLAW_LOCAL_COLLECTOR_MAX_RESULTS;
		birdMocks.listThread.mockReset();
		birdMocks.listUserTweets.mockReset();
		birdMocks.searchTweets.mockReset();
		syncHomeTimelineMock.mockReset();
		ingestTweetPayloadMock.mockReset();
		ingestTweetPayloadMock.mockReturnValue([]);
	});

	afterEach(() => {
		vi.useRealTimers();
		restoreEnvironment();
	});

	it("refreshes the full Following timeline with the documented defaults", async () => {
		syncHomeTimelineMock.mockResolvedValue({ count: 7, source: "bird" });
		const collector = new LocalTwitterCollector();

		await collector.runOnce();

		expect(syncHomeTimelineMock).toHaveBeenCalledWith({
			account: "account:test",
			mode: "bird",
			limit: 100,
			following: true,
			refresh: true,
		});
		expect(collector.getStatus()).toMatchObject({
			enabled: true,
			timelineEnabled: true,
			lastSuccessAt: "2026-08-09T12:00:00.000Z",
			lastTimelineSuccessAt: "2026-08-09T12:00:00.000Z",
			lastError: null,
			ingestedCount: 7,
			intervalSeconds: 120,
		});
		expect(collector.isFresh()).toBe(true);
		expect(collector.isFresh(new Date("2026-08-09T12:03:00.001Z"))).toBe(false);
	});

	it("preserves watched-user-only collection when timeline sync is disabled", async () => {
		delete process.env.BIRDCLAW_LOCAL_COLLECTOR_HOME_TIMELINE_ENABLED;
		process.env.BIRDCLAW_LOCAL_COLLECTOR_WATCH_USERS = "watched";
		birdMocks.listUserTweets.mockResolvedValue(emptyPayload);
		ingestTweetPayloadMock.mockReturnValue(["tweet:watched"]);
		const collector = new LocalTwitterCollector();

		await collector.runOnce();

		expect(syncHomeTimelineMock).not.toHaveBeenCalled();
		expect(birdMocks.listUserTweets).toHaveBeenCalledWith({
			username: "watched",
			maxResults: 100,
			maxPages: 3,
		});
		expect(collector.getStatus()).toMatchObject({
			timelineEnabled: false,
			lastSuccessAt: "2026-08-09T12:00:00.000Z",
			lastTimelineSuccessAt: null,
			lastError: null,
			ingestedCount: 1,
		});
		expect(collector.isFresh()).toBe(true);
	});

	it("does not report watched-user success as a fresh full timeline", async () => {
		process.env.BIRDCLAW_LOCAL_COLLECTOR_WATCH_USERS = "watched";
		syncHomeTimelineMock.mockRejectedValue(new Error("bird home failed"));
		birdMocks.listUserTweets.mockResolvedValue(emptyPayload);
		ingestTweetPayloadMock.mockReturnValue(["tweet:watched"]);
		const collector = new LocalTwitterCollector();

		await collector.runOnce();

		expect(birdMocks.listUserTweets).toHaveBeenCalledOnce();
		expect(collector.getStatus()).toMatchObject({
			lastSuccessAt: null,
			lastTimelineSuccessAt: null,
			lastError: "Home timeline sync failed: bird home failed",
			ingestedCount: 1,
		});
		expect(collector.isFresh()).toBe(false);
	});

	it("keeps the collector fresh when Home succeeds but a supplemental watch fails", async () => {
		process.env.BIRDCLAW_LOCAL_COLLECTOR_WATCH_USERS = "watched";
		syncHomeTimelineMock.mockResolvedValue({ count: 4, source: "bird" });
		birdMocks.listUserTweets.mockRejectedValue(
			new Error("profile rate limited"),
		);
		const collector = new LocalTwitterCollector();

		await collector.runOnce();

		expect(collector.getStatus()).toMatchObject({
			lastSuccessAt: null,
			lastTimelineSuccessAt: "2026-08-09T12:00:00.000Z",
			lastError: "Watched user @watched sync failed: profile rate limited",
			ingestedCount: 4,
		});
		expect(collector.isFresh()).toBe(true);
		expect(collector.isFresh(new Date("2026-08-09T12:03:00.001Z"))).toBe(false);
	});

	it("prevents overlapping interval runs and stops future runs", async () => {
		const timeline = deferred<{ count: number; source: string }>();
		syncHomeTimelineMock.mockReturnValue(timeline.promise);
		const collector = new LocalTwitterCollector();

		collector.start();
		await vi.advanceTimersByTimeAsync(240_000);
		expect(syncHomeTimelineMock).toHaveBeenCalledTimes(1);

		collector.stop();
		timeline.resolve({ count: 2, source: "bird" });
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(360_000);

		expect(syncHomeTimelineMock).toHaveBeenCalledTimes(1);
	});
});
