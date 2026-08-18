// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "#/lib/config";
import { getNativeDb, resetDatabaseForTests } from "#/lib/db";
import { writeSyncCache } from "#/lib/sync-cache";
import { getRouteHandler } from "#/test/route-handlers";
import { Route } from "./feed-article";

const tempDirs: string[] = [];
const GET = getRouteHandler(Route, "GET");

function setupArticle() {
	const tempDir = mkdtempSync(
		path.join(os.tmpdir(), "birdclaw-feed-article-api-"),
	);
	tempDirs.push(tempDir);
	process.env.BIRDCLAW_HOME = tempDir;
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
	const itemId = "tiger:article:1234567890";
	const sourceHash = "source-hash";
	getNativeDb()
		.prepare(
			`insert into feed_items (
			 id, source, external_id, kind, title, summary, url, publisher,
			 published_at, market, language, symbols_json, image_url, is_important,
			 content_hash, first_seen_at, updated_at
			) values (?, 'tiger', '1234567890', 'article', ?, ?, ?, ?, ?, 'us',
			          'zh-CN', '[]', null, 0, ?, ?, ?)`,
		)
		.run(
			itemId,
			"A full article",
			"Short excerpt",
			"https://www.laohu8.com/news/1234567890",
			"Tiger News",
			"2026-08-18T08:00:00.000Z",
			sourceHash,
			"2026-08-18T08:00:00.000Z",
			"2026-08-18T08:00:00.000Z",
		);
	const content = "First paragraph.\n\nFull article detail.";
	writeSyncCache(`editorial-feed:article-content:v1:${itemId}`, {
		itemId,
		externalId: "1234567890",
		content,
		contentHash: createHash("sha256").update(content).digest("hex"),
		sourceHash,
		fetchedAt: "2026-08-18T09:00:00.000Z",
	});
	return itemId;
}

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("feed article api route", () => {
	it("returns 400 for a missing id and 404 for an unknown item", async () => {
		setupArticle();
		expect(
			(
				await GET({
					request: new Request("http://birdclaw.test/api/feed-article"),
				})
			).status,
		).toBe(400);
		expect(
			(
				await GET({
					request: new Request(
						"http://birdclaw.test/api/feed-article?id=tiger%3Aarticle%3A0",
					),
				})
			).status,
		).toBe(404);
	});

	it("returns cached full text without exposing the cache publicly", async () => {
		const itemId = setupArticle();
		const response = await GET({
			request: new Request(
				`http://birdclaw.test/api/feed-article?id=${encodeURIComponent(itemId)}`,
			),
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(await response.json()).toMatchObject({
			ok: true,
			cached: true,
			content: "First paragraph.\n\nFull article detail.",
		});
	});
});
