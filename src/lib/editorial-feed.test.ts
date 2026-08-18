// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import {
	__test__,
	countFeedItems,
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
		expect(new URL(requestedUrls[0] ?? "").searchParams.get("type")).toBe("us");
		expect(new URL(requestedUrls[1] ?? "").searchParams.get("t")).toBe(
			String(Date.parse("2026-08-18T11:00:00.000Z")),
		);
		expect(
			listFeedItems({ kind: "flash" }).map((item) => ({
				externalId: item.externalId,
				market: item.market,
			})),
		).toEqual([
			{ externalId: "latest", market: "us" },
			{ externalId: "older", market: "us" },
		]);
		expect(getFeedSyncStatus("flash")).toMatchObject({
			state: "ready",
			lastItemAt: "2026-08-18T11:00:00.000Z",
		});
	});

	it("hides legacy global flashes and reclassifies US items on the first sync", async () => {
		getNativeDb()
			.prepare(
				`insert into feed_items (
					id, source, external_id, kind, title, summary, url, publisher,
					published_at, market, language, symbols_json, image_url,
					is_important, content_hash, first_seen_at, updated_at
				) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				"tiger:flash:legacy-global",
				"tiger",
				"legacy-global",
				"flash",
				"Legacy global flash",
				"",
				"https://www.laohu8.com/news/breaking?onlyImportant=true",
				"Tiger News",
				"2026-08-18T11:00:00.000Z",
				"all",
				"zh-CN",
				"[]",
				null,
				1,
				"legacy-global-hash",
				"2026-08-18T12:00:00.000Z",
				"2026-08-18T12:00:00.000Z",
			);

		expect(listFeedItems({ kind: "flash" })).toEqual([]);
		expect(countFeedItems({ kind: "flash" })).toBe(0);
		expect(countFeedItems()).toBe(0);

		let requests = 0;
		const fetchImpl = async (input: string | URL | Request) => {
			requests += 1;
			const cursor = new URL(String(input)).searchParams.get("t");
			return jsonResponse({
				code: 91_000_000,
				status: 200,
				items: cursor
					? [flashItem("older-us", "2026-08-10T11:00:00.000Z")]
					: [flashItem("legacy-global", "2026-08-18T11:00:00.000Z")],
			});
		};
		await syncTigerFeed("flash", {
			fetchImpl: fetchImpl as typeof fetch,
			now: () => new Date("2026-08-18T12:00:00.000Z"),
		});

		expect(requests).toBe(2);
		expect(
			listFeedItems({ kind: "flash" }).map((item) => ({
				externalId: item.externalId,
				market: item.market,
			})),
		).toEqual([
			{ externalId: "legacy-global", market: "us" },
			{ externalId: "older-us", market: "us" },
		]);
		expect(countFeedItems({ kind: "flash" })).toBe(2);
		expect(countFeedItems()).toBe(2);
	});

	it("fails closed when required Tiger app-data fields disappear", () => {
		expect(() =>
			__test__.normalizeFlashItems(
				{ data: { breakingNews: {} } },
				"2026-08-18T12:00:00.000Z",
			),
		).toThrow(/breakingNews|listData/);
		expect(() =>
			__test__.normalizeFlashItems(
				{
					data: {
						breakingNews: {
							listData: [flashItem("global", "2026-08-18T11:00:00.000Z")],
							market: "all",
							onlyImportant: true,
						},
					},
				},
				"2026-08-18T12:00:00.000Z",
			),
		).toThrow(/market/);
	});

	it("keeps article storage within the canonical-link and excerpt boundary", () => {
		const [
			safeArticle,
			article,
			mixedAnalysis,
			uncertainRights,
			uncertainRisk,
			uncertainTag,
		] = __test__.normalizeArticleItems(
			{
				items: [
					{
						id: "safe-article",
						title: "Factual company filing",
						pubTimestamp: Date.parse("2026-08-18T08:00:00.000Z") / 1_000,
						media: "Publisher",
						summary: "F".repeat(600),
						news_tag: "shareholding,buyback",
						isHighRisk: false,
						rights: null,
						symbols: [],
					},
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
					{
						id: "article-2",
						title: "Mixed-tag analysis",
						pubTimestamp: Date.parse("2026-08-18T08:00:00.000Z") / 1_000,
						media: "Publisher",
						summary: "This mixed-tag analysis must also stay out.",
						news_tag: "shareholding,analysis",
						isHighRisk: false,
						rights: null,
						symbols: [],
					},
					{
						id: "article-3",
						title: "Unknown rights",
						pubTimestamp: Date.parse("2026-08-18T08:00:00.000Z") / 1_000,
						media: "Publisher",
						summary: "This must stay out when safety fields are absent.",
						news_tag: "breaking",
						isHighRisk: false,
						symbols: [],
					},
					{
						id: "article-4",
						title: "Unknown risk flag",
						pubTimestamp: Date.parse("2026-08-18T08:00:00.000Z") / 1_000,
						media: "Publisher",
						summary: "This must stay out when isHighRisk is absent.",
						news_tag: "breaking",
						rights: null,
						symbols: [],
					},
					{
						id: "article-5",
						title: "Unknown content tag",
						pubTimestamp: Date.parse("2026-08-18T08:00:00.000Z") / 1_000,
						media: "Publisher",
						summary: "This must stay out when news_tag is absent.",
						isHighRisk: false,
						rights: null,
						symbols: [],
					},
				],
				code: 91_000_000,
				status: 200,
			},
			"2026-08-18T12:00:00.000Z",
		);
		expect(safeArticle).toMatchObject({
			url: "https://www.laohu8.com/news/safe-article",
			imageUrl: null,
		});
		expect(safeArticle?.summary).toHaveLength(500);
		expect(article).toMatchObject({
			url: "https://www.laohu8.com/news/article-1",
			summary: "",
			imageUrl: null,
		});
		expect(mixedAnalysis?.summary).toBe("");
		expect(uncertainRights?.summary).toBe("");
		expect(uncertainRisk?.summary).toBe("");
		expect(uncertainTag?.summary).toBe("");
	});
});
