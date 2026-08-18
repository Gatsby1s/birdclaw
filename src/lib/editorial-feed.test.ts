// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { resetDatabaseForTests } from "./db";
import {
	__test__,
	getFeedSyncStatus,
	listFeedItems,
	syncTigerFeed,
} from "./editorial-feed";

let temporaryHome = "";

function jsonResponse(value: unknown) {
	return new Response(JSON.stringify(value), {
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

function flashItem(id: string, publishedAt: string, important = true) {
	return {
		id,
		content: `Important flash ${id}`,
		isHighlight: important ? 1 : 0,
		pubTime: Date.parse(publishedAt),
		media: "Tiger News",
		symbols: ["AAPL"],
	};
}

beforeEach(() => {
	temporaryHome = mkdtempSync(path.join(os.tmpdir(), "birdclaw-feed-"));
	process.env.BIRDCLAW_HOME = temporaryHome;
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
});

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	rmSync(temporaryHome, { recursive: true, force: true });
});

describe("editorial feed", () => {
	it("backfills important flashes with the upstream time cursor", async () => {
		const requestedUrls: string[] = [];
		const fetchImpl = async (input: string | URL | Request) => {
			const url = new URL(String(input));
			requestedUrls.push(url.toString());
			const cursor = url.searchParams.get("t");
			return jsonResponse({
				code: 91_000_000,
				status: 200,
				items: cursor
					? [flashItem("older", "2026-08-10T12:00:00.000Z")]
					: [
							flashItem("latest", "2026-08-18T11:00:00.000Z"),
							flashItem("ordinary", "2026-08-18T10:00:00.000Z", false),
						],
			});
		};

		await expect(
			syncTigerFeed("flash", {
				fetchImpl: fetchImpl as typeof fetch,
				now: () => new Date("2026-08-18T12:00:00.000Z"),
			}),
		).resolves.toMatchObject({ kind: "flash", seen: 2, changed: 2 });
		expect(requestedUrls).toHaveLength(2);
		expect(new URL(requestedUrls[1] ?? "").searchParams.get("t")).toBe(
			String(Date.parse("2026-08-18T11:00:00.000Z")),
		);
		expect(
			listFeedItems({ kind: "flash" }).map((item) => item.externalId),
		).toEqual(["latest", "older"]);
		expect(getFeedSyncStatus("flash")).toMatchObject({
			state: "ready",
			lastItemAt: "2026-08-18T11:00:00.000Z",
		});
	});

	it("fails closed when required Tiger app-data fields disappear", () => {
		expect(() =>
			__test__.normalizeFlashItems(
				{ data: { breakingNews: {} } },
				"2026-08-18T12:00:00.000Z",
			),
		).toThrow(/breakingNews|listData/);
	});

	it("keeps article storage within the canonical-link and excerpt boundary", () => {
		const [article] = __test__.normalizeArticleItems(
			{
				items: [
					{
						id: "article-1",
						title: "Market analysis",
						pubTimestamp: Date.parse("2026-08-18T08:00:00.000Z") / 1_000,
						media: "Publisher",
						summary:
							"This analysis must not be copied into the factual digest.",
						news_tag: "analysis",
						isHighRisk: false,
						rights: null,
						thumbnail: "https://third-party.example/image.jpg",
						symbols: [],
					},
				],
				code: 91_000_000,
				status: 200,
			},
			"2026-08-18T12:00:00.000Z",
		);
		expect(article).toMatchObject({
			url: "https://www.laohu8.com/news/article-1",
			summary: "",
			imageUrl: null,
		});
	});
});
