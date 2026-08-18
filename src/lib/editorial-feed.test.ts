// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import {
	__test__,
	countFeedItems,
	getFeedArticleContent,
	getFeedSyncStatus,
	hydrateFeedArticleContents,
	listFeedItems,
	readFeedArticleContent,
	syncTigerFeed,
} from "./editorial-feed";
import { writeSyncCache } from "./sync-cache";

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

function articleItem(id: string) {
	return {
		id,
		title: "A factual company update",
		pubTimestamp: Date.parse("2026-08-18T08:00:00.000Z") / 1_000,
		media: "Tiger News",
		summary: "The company published a material update.",
		news_tag: "company",
		isHighRisk: false,
		rights: null,
		symbols: ["AAPL"],
	};
}

function articleDetail(id: string, content: string) {
	return {
		code: 200_060_000,
		status: 200,
		data: {
			code: "91000000",
			status: "200",
			id,
			article_id: id,
			content_text: content,
			need_auth: false,
			need_login_tip: false,
			rights: null,
		},
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

	it("fetches, preserves, and persistently caches the full article text", async () => {
		const id = "1234567890";
		const content = "First paragraph.\r\n\r\nLiteral <b>tag</b> and &amp;.";
		let listRequests = 0;
		let detailRequests = 0;
		const detailIds: Array<string | null> = [];
		const fetchImpl = async (input: string | URL | Request) => {
			const url = new URL(String(input));
			if (url.pathname === "/v2/news") {
				detailRequests += 1;
				detailIds.push(url.searchParams.get("id"));
				return jsonResponse(articleDetail(id, content));
			}
			listRequests += 1;
			return jsonResponse({
				code: 91_000_000,
				status: 200,
				items: [articleItem(id)],
			});
		};

		await syncTigerFeed("article", {
			fetchImpl: fetchImpl as typeof fetch,
			initialArticlePages: 1,
			now: () => new Date("2026-08-18T12:00:00.000Z"),
		});
		expect(listRequests).toBe(1);
		expect(detailRequests).toBe(1);
		expect(detailIds).toEqual([id]);
		expect(readFeedArticleContent(`tiger:article:${id}`)).toMatchObject({
			externalId: id,
			content: "First paragraph.\n\nLiteral <b>tag</b> and &amp;.",
		});

		await expect(
			getFeedArticleContent(`tiger:article:${id}`, {
				fetchImpl: fetchImpl as typeof fetch,
			}),
		).resolves.toMatchObject({
			cached: true,
			content: "First paragraph.\n\nLiteral <b>tag</b> and &amp;.",
		});
		expect(detailRequests).toBe(1);

		getNativeDb()
			.prepare("delete from sync_cache where cache_key = ?")
			.run(`editorial-feed:article-content:v1:tiger:article:${id}`);
		await Promise.all([
			getFeedArticleContent(`tiger:article:${id}`, {
				fetchImpl: fetchImpl as typeof fetch,
			}),
			getFeedArticleContent(`tiger:article:${id}`, {
				fetchImpl: fetchImpl as typeof fetch,
			}),
		]);
		expect(detailRequests).toBe(2);
		expect(detailIds).toEqual([id, id]);

		getNativeDb()
			.prepare("delete from sync_cache where cache_key = ?")
			.run(`editorial-feed:article-content:v1:tiger:article:${id}`);
		const hangingFetch = (_input: string | URL | Request, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener(
					"abort",
					() => reject(new DOMException("Aborted", "AbortError")),
					{ once: true },
				);
			});
		await expect(
			hydrateFeedArticleContents(listFeedItems({ kind: "article" }), {
				fetchImpl: hangingFetch as typeof fetch,
				timeoutMs: 20,
			}),
		).resolves.toEqual({ attempted: 1, hydrated: 0, failed: 1 });

		const source = getNativeDb()
			.prepare("select content_hash from feed_items where id = ?")
			.get(`tiger:article:${id}`) as { content_hash: string };
		const corruptContent = "Schema-valid but semantically corrupt body";
		writeSyncCache(`editorial-feed:article-content:v1:tiger:article:${id}`, {
			itemId: "tiger:article:wrong",
			externalId: id,
			content: corruptContent,
			contentHash: createHash("sha256").update(corruptContent).digest("hex"),
			sourceHash: source.content_hash,
			fetchedAt: "2026-08-18T12:00:00.000Z",
		});
		expect(readFeedArticleContent(`tiger:article:${id}`)).toBeNull();
		writeSyncCache(`editorial-feed:article-content:v1:tiger:article:${id}`, {
			itemId: `tiger:article:${id}`,
			externalId: id,
			content: corruptContent,
			contentHash: "a".repeat(64),
			sourceHash: source.content_hash,
			fetchedAt: "2026-08-18T12:00:00.000Z",
		});
		expect(readFeedArticleContent(`tiger:article:${id}`)).toBeNull();
	});

	it("rejects mismatched, gated, empty, and oversized article details", () => {
		const valid = articleDetail("1234567890", "Readable body");
		expect(() => __test__.normalizeArticleDetail(valid, "9999999999")).toThrow(
			/match/,
		);
		expect(() =>
			__test__.normalizeArticleDetail(
				{
					...valid,
					data: { ...valid.data, need_auth: true },
				},
				"1234567890",
			),
		).toThrow(/need_auth/);
		expect(() =>
			__test__.normalizeArticleDetail(
				{ ...valid, data: { ...valid.data, content_text: " \r\n " } },
				"1234567890",
			),
		).toThrow(/readable text/);
		expect(() =>
			__test__.normalizeArticleContent("界".repeat(180_000)),
		).toThrow(/too large/);
	});
});
