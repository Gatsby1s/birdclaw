// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import {
	deleteDiscussionHistory,
	findDiscussionHistoryIdByCacheKey,
	getDiscussionHistory,
	listDiscussionHistory,
	saveDiscussionHistory,
	updateDiscussionHistory,
} from "./discussion-history";
import {
	collectSearchDiscussionContext,
	type SearchDiscussionRunResult,
} from "./search-discussion";

let tempRoot = "";

beforeEach(() => {
	tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-history-"));
	process.env.BIRDCLAW_HOME = tempRoot;
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
});

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	rmSync(tempRoot, { recursive: true, force: true });
});

function discussionResult(): SearchDiscussionRunResult {
	const context = collectSearchDiscussionContext({
		query: "local-first",
		includeDms: true,
		limit: 20,
	});
	return {
		context,
		discussion: {
			title: "Durable local memory",
			summary: "The archive discussion centered on durable local state.",
			themes: [
				{
					title: "Durability",
					summary: "Repairable local archives matter.",
					tweetIds: ["001"],
					dmConversationIds: ["dm:001"],
					handles: ["sam"],
				},
			],
			tensions: [],
			followUps: [],
			sourceTweetIds: [],
			sourceDmConversationIds: [],
		},
		markdown:
			"# Durable local memory\n\nThe cited archive is repairable (tweet_001) and the private follow-up is recorded (dm_001).",
		model: "gpt-5.5",
		reasoningEffort: "medium",
		serviceTier: "priority",
		cached: false,
		updatedAt: "2026-07-19T03:00:00.000Z",
	};
}

describe("discussion history", () => {
	it("stores lightweight metadata and only cited source snapshots", () => {
		const db = getNativeDb();
		const result = discussionResult();
		const id = saveDiscussionHistory(
			{
				cacheKey: "discussion:test",
				options: {
					query: "local-first",
					mode: "local",
					includeDms: true,
					originalsOnly: true,
					hideLowQuality: true,
				},
				result,
			},
			db,
		);

		const items = listDiscussionHistory({}, db);
		expect(items).toEqual([
			expect.objectContaining({
				id,
				title: "Durable local memory",
				query: "local-first",
				mode: "local",
				includeDms: true,
				originalsOnly: true,
				hideLowQuality: true,
				themeTitles: ["Durability"],
				sourceCount: 1,
				dmCount: 1,
				versionCount: 1,
			}),
		]);

		const detail = getDiscussionHistory(id, db);
		expect(detail?.result.historyId).toBe(id);
		expect(detail?.result.context.hash).toBe(result.context.hash);
		expect(detail?.result.context.counts).toEqual(result.context.counts);
		expect(detail?.result.context.tweets.map((tweet) => tweet.id)).toEqual([
			"tweet_001",
		]);
		expect(detail?.result.context.dms.map((dm) => dm.id)).toEqual(["dm_001"]);
		expect(detail?.result.context.tweets.length).toBeLessThanOrEqual(
			result.context.tweets.length,
		);
	});

	it("links refreshed versions and reuses the newest active cache history", () => {
		const db = getNativeDb();
		const result = discussionResult();
		const firstId = saveDiscussionHistory(
			{
				cacheKey: "discussion:versioned",
				options: { query: "local-first", mode: "local" },
				result,
			},
			db,
		);
		const secondId = saveDiscussionHistory(
			{
				cacheKey: "discussion:versioned",
				options: {
					query: "local-first",
					mode: "local",
					refresh: true,
					parentHistoryId: firstId,
				},
				result: {
					...result,
					discussion: { ...result.discussion, title: "Updated memory" },
					updatedAt: "2026-07-19T04:00:00.000Z",
				},
			},
			db,
		);

		expect(findDiscussionHistoryIdByCacheKey("discussion:versioned", db)).toBe(
			secondId,
		);
		expect(getDiscussionHistory(secondId, db)?.metadata).toEqual(
			expect.objectContaining({ parentId: firstId, versionCount: 2 }),
		);
		expect(getDiscussionHistory(firstId, db)?.metadata.versionCount).toBe(2);

		expect(listDiscussionHistory({}, db).map((item) => item.id)).toEqual([
			secondId,
		]);
		expect(deleteDiscussionHistory(secondId, db)).toBe(true);
		expect(
			findDiscussionHistoryIdByCacheKey("discussion:versioned", db),
		).toBeNull();
		expect(getDiscussionHistory(secondId, db)).toBeNull();
		expect(getDiscussionHistory(firstId, db)).toBeNull();
	});

	it("resolves cited ids with underscores, colons, and hyphens exactly", () => {
		const db = getNativeDb();
		const result = discussionResult();
		const original = result.context.tweets[0];
		expect(original).toBeDefined();
		const citedId = "tweet_alpha_beta-gamma";
		const id = saveDiscussionHistory(
			{
				cacheKey: "discussion:compound-id",
				options: { query: "local-first", mode: "local" },
				result: {
					...result,
					context: {
						...result.context,
						tweets: [
							{ ...original!, id: citedId },
							...result.context.tweets.slice(1),
						],
					},
					discussion: {
						...result.discussion,
						sourceTweetIds: ["tweet:alpha_beta-gamma"],
						themes: [],
					},
					markdown: "Exact compound citation (tweet_alpha_beta-gamma).",
				},
			},
			db,
		);

		expect(
			getDiscussionHistory(id, db)?.result.context.tweets.map(
				(tweet) => tweet.id,
			),
		).toEqual([citedId]);
	});

	it("renames and pins an existing history item", () => {
		const db = getNativeDb();
		const id = saveDiscussionHistory(
			{
				cacheKey: "discussion:editable",
				options: { query: "local-first", mode: "local" },
				result: discussionResult(),
			},
			db,
		);

		const updated = updateDiscussionHistory(
			id,
			{ title: "Pinned research", pinned: true },
			db,
		);
		expect(updated).toEqual(
			expect.objectContaining({ title: "Pinned research", pinned: true }),
		);
		expect(getDiscussionHistory(id, db)?.metadata.title).toBe(
			"Pinned research",
		);
	});
});
