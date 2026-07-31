// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
	insertTestAccount,
	insertTestProfile,
	insertTestTweet,
	withTestHome,
} from "../test/test-home";
import { fetchRagTweet, searchRagTweets } from "./rag-mcp-store";

describe("BirdClaw RAG store", () => {
	it("searches English and Chinese archive text with stable citation URLs", async () => {
		await withTestHome(async ({ db }) => {
			insertTestAccount(db);
			insertTestProfile(db, {
				id: "profile:researcher",
				handle: "researcher",
				displayName: "Researcher",
			});
			insertTestTweet(db, {
				id: "100",
				authorProfileId: "profile:researcher",
				text: "A vector database can support semantic retrieval for a personal knowledge base.",
				likeCount: 20,
			});
			insertTestTweet(db, {
				id: "200",
				authorProfileId: "profile:researcher",
				text: "构建个人知识库时，先保证资料可检索，再逐步加入向量语义召回。",
				createdAt: "2026-02-01T00:00:00.000Z",
			});
			db.prepare("insert into tweets_fts (tweet_id, text) values (?, ?)").run(
				"100",
				"A vector database can support semantic retrieval for a personal knowledge base.",
			);
			db.prepare("insert into tweets_fts (tweet_id, text) values (?, ?)").run(
				"200",
				"构建个人知识库时，先保证资料可检索，再逐步加入向量语义召回。",
			);

			expect(searchRagTweets("vector database")[0]).toMatchObject({
				id: "tweet:100",
				url: "https://x.com/researcher/status/100",
			});
			expect(searchRagTweets("知识库怎么做")[0]).toMatchObject({
				id: "tweet:200",
				url: "https://x.com/researcher/status/200",
			});
		});
	});

	it("fetches a tweet with archived parent, quote, reply, and collection context", async () => {
		await withTestHome(async ({ db }) => {
			insertTestAccount(db);
			insertTestProfile(db, {
				id: "profile:author",
				handle: "author",
				displayName: "Author",
			});
			insertTestTweet(db, {
				id: "parent",
				authorProfileId: "profile:author",
				text: "Parent context",
			});
			insertTestTweet(db, {
				id: "quote",
				authorProfileId: "profile:author",
				text: "Quoted evidence",
			});
			insertTestTweet(db, {
				id: "root",
				authorProfileId: "profile:author",
				text: "Main archived claim",
				replyToId: "parent",
				quotedTweetId: "quote",
			});
			insertTestTweet(db, {
				id: "reply",
				authorProfileId: "profile:author",
				text: "Reply context",
				replyToId: "root",
			});
			db.prepare(
				`insert into tweet_collections (
					account_id, tweet_id, kind, collected_at, source, raw_json, updated_at
				) values (?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"account:test",
				"root",
				"bookmarks",
				"2026-01-01T00:00:00.000Z",
				"test",
				"{}",
				"2026-01-01T00:00:00.000Z",
			);

			const document = fetchRagTweet("tweet:root");
			expect(document).toMatchObject({
				id: "tweet:root",
				url: "https://x.com/author/status/root",
				metadata: {
					bookmarked: true,
					parent_count: 1,
					reply_count: 1,
					quoted_tweet_id: "quote",
				},
			});
			expect(document?.text).toContain("Main archived claim");
			expect(document?.text).toContain("Parent context");
			expect(document?.text).toContain("Quoted evidence");
			expect(document?.text).toContain("Reply context");
		});
	});
});
