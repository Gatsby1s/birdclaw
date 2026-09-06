// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
	withTestHome,
	insertTestAccount,
	insertTestProfile,
	insertTestTweet,
} from "../test/test-home";
import { getNativeDb } from "./db";
import {
	addPersonSource,
	createPerson,
	upsertPersonDocument,
} from "./person-archive-store";
import { searchPersonArchive, fetchPersonArchive } from "./person-archive-rag";
function setup() {
	const db = getNativeDb({ seedDemoData: false });
	insertTestAccount(db);
	return db;
}
describe("person archive retrieval", () => {
	it("finds late PDF text and preserves source page/chunk links while excluding another person", () =>
		withTestHome(() => {
			const db = setup();
			const person = createPerson(db, "研究者甲");
			const other = createPerson(db, "研究者乙");
			const text =
				"First page background. ".repeat(210) +
				"\f" +
				"second page 财政政策与资产周期";
			const doc = upsertPersonDocument(db, {
				personId: person,
				kind: "document",
				title: "历史报告",
				text,
				publishedAt: "2025-01-01T00:00:00.000Z",
				filename: "report.pdf",
				storageKey: "documents/fixture.pdf",
			});
			upsertPersonDocument(db, {
				personId: other,
				kind: "document",
				title: "无关作者",
				text: "财政政策与资产周期",
				publishedAt: "2026-01-01T00:00:00.000Z",
			});
			const results = searchPersonArchive(`person:"研究者甲" 财政政策`);
			expect(results.length).toBeGreaterThan(0);
			expect(results.every((row) => row.id.startsWith(`doc:${doc.id}:`))).toBe(
				true,
			);
			const fetched = fetchPersonArchive(results[0].id)!;
			expect(fetched.text).toContain("财政政策");
			expect(fetched.metadata.person_id).toBe(person);
			expect(fetched.metadata.filename).toBe("report.pdf");
			expect(fetched.metadata.chunk_count).toBeGreaterThan(1);
			expect(fetched.metadata.author_context).toMatchObject({
				label_status: "unlabeled",
			});
			expect(searchPersonArchive("person:不存在 财政政策")).toEqual([]);
			expect(fetchPersonArchive("doc:../../secret")).toBeNull();
		}));
	it("keeps channel forwarding provenance and indexes edits without duplicating notification events", () =>
		withTestHome(() => {
			const db = setup();
			const person = createPerson(db, "频道作者");
			const source = addPersonSource(db, person, "telegram", "public_channel");
			const data = {
				personId: person,
				sourceId: source,
				externalId: "10",
				kind: "telegram" as const,
				title: "频道消息",
				publishedAt: "2026-01-01T00:00:00.000Z",
				sourceUrl: "https://t.me/public_channel/10",
				rawJson: { attribution: "forwarded", forwardedFrom: "原作者" },
			};
			const doc = upsertPersonDocument(db, {
				...data,
				text: "旧版观点 alphaword",
			});
			expect(searchPersonArchive("alphaword")).toHaveLength(1);
			upsertPersonDocument(db, { ...data, text: "修订观点 betaword" });
			expect(searchPersonArchive("alphaword")).toHaveLength(0);
			const result = searchPersonArchive("person:public_channel betaword")[0];
			expect(result.id).toContain(doc.id);
			const fetched = fetchPersonArchive(result.id)!;
			expect(fetched.metadata.provenance).toMatchObject({
				attribution: "forwarded",
				forwardedFrom: "原作者",
			});
			expect(fetched.text).toContain("可能由多人运营");
			expect(
				db.prepare("select count(*) n from person_events").get(),
			).toMatchObject({ n: 1 });
		}));
	it("searches X and documents within one person without leaking another X author", () =>
		withTestHome(() => {
			const db = setup();
			insertTestProfile(db, {
				id: "profile_user_11",
				handle: "authorone",
				displayName: "作者甲",
			});
			insertTestProfile(db, {
				id: "profile_user_22",
				handle: "authortwo",
				displayName: "作者乙",
			});
			insertTestTweet(db, {
				id: "1001",
				authorProfileId: "profile_user_11",
				text: "原始推文 bondpolicy",
			});
			insertTestTweet(db, {
				id: "1002",
				authorProfileId: "profile_user_22",
				text: "其他作者 bondpolicy",
			});
			const person = createPerson(db, "作者甲");
			addPersonSource(db, person, "x", "authorone");
			upsertPersonDocument(db, {
				personId: person,
				kind: "document",
				title: "补充资料",
				text: "上传补充 bondpolicy",
				publishedAt: "2026-01-01T00:00:00.000Z",
			});
			const results = searchPersonArchive(`person:${person} bondpolicy`);
			expect(results.some((r) => r.id === "tweet:1001")).toBe(true);
			expect(results.some((r) => r.id.startsWith("doc:"))).toBe(true);
			expect(results.some((r) => r.id === "tweet:1002")).toBe(false);
			expect(fetchPersonArchive("tweet:1001")?.text).toContain("bondpolicy");
		}));
});
