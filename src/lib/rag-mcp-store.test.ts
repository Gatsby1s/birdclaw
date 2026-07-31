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
			db.prepare(
				`insert into xremark_profile_notes (
					identifier, additional_name, given_name, remark, description,
					tags_json, category_name, source_created_at, source_updated_at,
					imported_at
				) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"profile:researcher",
				"researcher",
				"Researcher",
				"Treat claims as a contrarian signal",
				"Followed to monitor consensus errors, not to copy trades",
				JSON.stringify(["反指", "宏观"]),
				"风险观察",
				null,
				1_752_499_700_000,
				"2026-01-01T00:00:00.000Z",
			);
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
				author_context: {
					label_status: "recorded",
					labels: ["风险观察", "反指", "宏观"],
					personal_note: "Treat claims as a contrarian signal",
					follow_reason:
						"Followed to monitor consensus errors, not to copy trades",
				},
			});
			expect(searchRagTweets("vector database")[0]?.title).toContain("反指");
			expect(searchRagTweets("反指")[0]).toMatchObject({
				id: "tweet:100",
				author_context: { labels: ["风险观察", "反指", "宏观"] },
			});
			expect(searchRagTweets("知识库怎么做")[0]).toMatchObject({
				id: "tweet:200",
				url: "https://x.com/researcher/status/200",
			});
		});
	});

	it("marks authors without X Remark context as unlabeled", async () => {
		await withTestHome(async ({ db }) => {
			insertTestAccount(db);
			insertTestProfile(db, {
				id: "profile:unlabeled",
				handle: "unlabeled",
				displayName: "Unlabeled",
			});
			insertTestTweet(db, {
				id: "300",
				authorProfileId: "profile:unlabeled",
				text: "Unlabeled author claim",
			});
			db.prepare("insert into tweets_fts (tweet_id, text) values (?, ?)").run(
				"300",
				"Unlabeled author claim",
			);

			const result = searchRagTweets("author claim")[0];
			expect(result?.author_context).toMatchObject({
				label_status: "unlabeled",
				labels: [],
			});
			expect(result?.title).toContain("作者标注：未标注");
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
				`insert into xremark_profile_notes (
					identifier, additional_name, given_name, remark, description,
					tags_json, category_name, imported_at
				) values (?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"profile:author",
				"author",
				"Author",
				"Do not follow directly",
				"Tracked as a reverse indicator",
				JSON.stringify(["反指"]),
				"风险观察",
				"2026-01-01T00:00:00.000Z",
			);
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
					author_context: {
						label_status: "recorded",
						labels: ["风险观察", "反指"],
						personal_note: "Do not follow directly",
						follow_reason: "Tracked as a reverse indicator",
					},
					parent_count: 1,
					reply_count: 1,
					quoted_tweet_id: "quote",
				},
			});
			expect(document?.text).toContain("Main archived claim");
			expect(document?.text).toContain("Parent context");
			expect(document?.text).toContain("Quoted evidence");
			expect(document?.text).toContain("Reply context");
			expect(document?.text).toContain("Author judgment context");
			expect(document?.text).toContain("反指");
			expect(document?.text).toContain("Tracked as a reverse indicator");
		});
	});
});
