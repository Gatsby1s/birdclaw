// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const maybeAutoSyncBackupMock = vi.hoisted(() => vi.fn());
const syncHomeTimelineMock = vi.hoisted(() => vi.fn());
const syncMentionThreadsMock = vi.hoisted(() => vi.fn());
const syncMentionsMock = vi.hoisted(() => vi.fn());

vi.mock("./backup", () => ({
	maybeAutoSyncBackupEffect: (...args: unknown[]) =>
		Effect.tryPromise({
			try: () => maybeAutoSyncBackupMock(...args),
			catch: (error) => error,
		}),
}));

vi.mock("./mention-threads-live", () => ({
	syncMentionThreadsEffect: (...args: unknown[]) =>
		Effect.tryPromise({
			try: () => syncMentionThreadsMock(...args),
			catch: (error) => error,
		}),
}));

vi.mock("./mentions-live", () => ({
	syncMentionsEffect: (...args: unknown[]) =>
		Effect.tryPromise({
			try: () => syncMentionsMock(...args),
			catch: (error) => error,
		}),
}));

vi.mock("./timeline-live", () => ({
	syncHomeTimelineEffect: (...args: unknown[]) =>
		Effect.tryPromise({
			try: () => syncHomeTimelineMock(...args),
			catch: (error) => error,
		}),
}));

import { resetBirdclawPathsForTests } from "./config";
import { resetDatabaseForTests } from "./db";
import { streamPeriodDigest } from "./period-digest";

const tempRoots: string[] = [];

function setupTempHome() {
	const tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-digest-live-"));
	tempRoots.push(tempRoot);
	process.env.BIRDCLAW_HOME = tempRoot;
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
}

function sseFrame(value: unknown) {
	return `data: ${JSON.stringify(value)}\n\n`;
}

function streamResponse(text: string) {
	return new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(text));
				controller.close();
			},
		}),
	);
}

describe("period digest live refresh", () => {
	beforeEach(() => {
		setupTempHome();
		process.env.OPENAI_API_KEY = "test-key";
		maybeAutoSyncBackupMock.mockReset();
		syncHomeTimelineMock.mockReset();
		syncMentionThreadsMock.mockReset();
		syncMentionsMock.mockReset();
		maybeAutoSyncBackupMock.mockResolvedValue({
			ok: true,
			enabled: false,
			skipped: true,
		});
		syncHomeTimelineMock.mockResolvedValue({
			ok: true,
			source: "xurl",
			count: 0,
		});
		syncMentionsMock.mockResolvedValue({
			ok: true,
			source: "xurl",
			count: 0,
		});
		syncMentionThreadsMock.mockResolvedValue({
			ok: true,
			source: "xurl",
			mergedTweets: 0,
		});
	});

	afterEach(() => {
		resetDatabaseForTests();
		resetBirdclawPathsForTests();
		delete process.env.BIRDCLAW_HOME;
		delete process.env.OPENAI_API_KEY;
		vi.unstubAllGlobals();
		for (const tempRoot of tempRoots.splice(0)) {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	it("serves cached digests before hydrating mention threads", async () => {
		const streamed = [
			sseFrame({
				type: "response.output_text.delta",
				delta:
					'# Cached\n\nFirst pass.\n\n---\n{"title":"Cached","summary":"First pass","keyTopics":[],"notableLinks":[],"people":[],"actionItems":[],"sourceTweetIds":[]}',
			}),
			"data: [DONE]\n\n",
		].join("");
		const fetchMock = vi.fn().mockResolvedValue(streamResponse(streamed));
		vi.stubGlobal("fetch", fetchMock);
		const options = {
			since: "2026-01-01T00:00:00.000Z",
			until: "2027-01-01T00:00:00.000Z",
			liveSync: true,
		};

		await streamPeriodDigest({ ...options, refresh: true });
		syncMentionThreadsMock.mockClear();
		const cached = await streamPeriodDigest(options);

		expect(cached.cached).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(syncHomeTimelineMock).toHaveBeenCalled();
		expect(syncMentionsMock).toHaveBeenCalled();
		expect(syncHomeTimelineMock.mock.calls[0]?.[0]).toMatchObject({
			limit: undefined,
			maxPages: undefined,
			startTime: "2026-01-01T00:00:00.000Z",
		});
		expect(syncMentionsMock.mock.calls[0]?.[0]).toMatchObject({
			limit: 100,
			maxPages: undefined,
			startTime: "2026-01-01T00:00:00.000Z",
		});
		expect(syncMentionThreadsMock).not.toHaveBeenCalled();
		expect(maybeAutoSyncBackupMock).toHaveBeenCalled();
	});

	it("hydrates only mention threads from the digest window on cache miss", async () => {
		const streamed = [
			sseFrame({
				type: "response.output_text.delta",
				delta:
					'# Live\n\nFresh pass.\n\n---\n{"title":"Live","summary":"Fresh pass","keyTopics":[],"notableLinks":[],"people":[],"actionItems":[],"sourceTweetIds":[]}',
			}),
			"data: [DONE]\n\n",
		].join("");
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamResponse(streamed)));

		await streamPeriodDigest({
			since: "2026-01-01T00:00:00.000Z",
			until: "2027-01-01T00:00:00.000Z",
			refresh: true,
			liveSync: true,
		});

		const threadOptions = syncMentionThreadsMock.mock.calls.at(-1)?.[0] as {
			tweetIds?: string[];
		};
		expect(threadOptions.tweetIds).toEqual(expect.any(Array));
		expect(threadOptions.tweetIds?.length).toBeGreaterThan(0);
	});
});
