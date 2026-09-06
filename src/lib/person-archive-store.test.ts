// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { ensurePersonArchiveTables } from "./person-archive-schema";
import {
	addPersonSource,
	createPerson,
	enqueuePersonAsset,
	getPersonDetail,
	getPersonItems,
	listPeoplePage,
	markPersonRead,
	mergePeople,
	normalizePersonSource,
	personLatestSequence,
	recordPersonEvent,
	requirePerson,
	upsertPersonDocument,
} from "./person-archive-store";
import Database from "./sqlite";

const databases: Database[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});
function setup() {
	const db = new Database(":memory:");
	databases.push(db);
	ensurePersonArchiveTables(db);
	db.exec(`create table profiles(id text primary key,handle text,display_name text,avatar_url text);
	create table tweets(id text primary key,author_profile_id text,text text,created_at text);
	create table twillot_history_jobs(profile_id text,capture_status text,last_error text,updated_at text);`);
	return db;
}
const publishedAt = "2026-09-06T00:00:00.000Z";
function doc(
	db: Database,
	personId: string,
	text: string,
	extra: Partial<Parameters<typeof upsertPersonDocument>[1]> = {},
) {
	return upsertPersonDocument(db, {
		personId,
		kind: "document",
		title: "Reference",
		text,
		publishedAt,
		...extra,
	});
}
function count(db: Database, table: string) {
	return (db.prepare(`select count(*) n from ${table}`).get() as { n: number })
		.n;
}

describe("person archive store", () => {
	it("normalizes public sources and rejects spoofed hosts, private invites, and message URLs", () => {
		expect(
			normalizePersonSource("x", "https://twitter.com/SomePerson"),
		).toEqual({ identifier: "someperson", url: "https://x.com/someperson" });
		expect(
			normalizePersonSource("telegram", "https://t.me/s/SomeChannel"),
		).toEqual({ identifier: "somechannel", url: "https://t.me/somechannel" });
		for (const value of [
			"https://t.me.evil.test/channel",
			"https://t.me@evil.test/channel",
			"https://t.me/+private",
			"https://t.me/joinchat/secret",
			"https://t.me/c/123",
			"https://t.me/channel/42",
			"https://t.me:8443/channel",
		])
			expect(() => normalizePersonSource("telegram", value)).toThrow(
				/链接|平台|频道/,
			);
		expect(() =>
			normalizePersonSource("x", "https://x.com/name/status/123"),
		).toThrow(/单条/);
	});
	it("keeps a renamed X numeric identity assigned to only one person", () => {
		const db = setup();
		const first = createPerson(db, "First");
		const second = createPerson(db, "Second");
		db.prepare(
			"insert into profiles values('profile_user_123','oldname','Author',null)",
		).run();
		const sourceId = addPersonSource(db, first, "x", "oldname");
		db.prepare(
			"update profiles set handle='newname' where id='profile_user_123'",
		).run();
		expect(addPersonSource(db, first, "x", "newname")).toBe(sourceId);
		expect(() => addPersonSource(db, second, "x", "newname")).toThrow(
			/其他人物/,
		);
		expect(count(db, "person_sources")).toBe(1);
	});
	it("associates the same remote media URL with each separate Telegram document", () => {
		const db = setup();
		const person = createPerson(db, "Author");
		const sourceId = addPersonSource(db, person, "telegram", "channel");
		const first = doc(db, person, "First", {
			kind: "telegram",
			sourceId,
			externalId: "1",
		});
		const second = doc(db, person, "Second", {
			kind: "telegram",
			sourceId,
			externalId: "2",
		});
		const asset = {
			personId: person,
			sourceId,
			remoteUrl: "https://cdn1.telesco.pe/file/same.jpg",
			kind: "image",
		};
		const firstAsset = enqueuePersonAsset(db, {
			...asset,
			documentId: first.id,
		});
		const secondAsset = enqueuePersonAsset(db, {
			...asset,
			documentId: second.id,
		});
		expect(firstAsset).not.toBe(secondAsset);
		expect(enqueuePersonAsset(db, { ...asset, documentId: first.id })).toBe(
			firstAsset,
		);
		const items = getPersonItems(db, { personId: person }).items;
		expect(items).toHaveLength(2);
		expect(items.every((item) => item.media.length === 1)).toBe(true);
	});
	it("deduplicates documents and refreshes both full text and overlapping search chunks after edits", () => {
		const db = setup();
		const person = createPerson(db, "Author");
		const sourceId = addPersonSource(db, person, "telegram", "channel");
		const input = {
			kind: "telegram" as const,
			sourceId,
			externalId: "1",
			isHistorical: true,
		};
		const first = doc(
			db,
			person,
			`obsoleteword ${"a".repeat(3980)}\f${"b".repeat(4300)}`,
			input,
		);
		const repeated = doc(
			db,
			person,
			`obsoleteword ${"a".repeat(3980)}\f${"b".repeat(4300)}`,
			input,
		);
		expect(repeated).toMatchObject({
			id: first.id,
			inserted: false,
			sequence: first.sequence,
		});
		const chunks = db
			.prepare(
				"select chunk_index,start_offset,page_start,length(text) length from person_document_chunks order by chunk_index",
			)
			.all();
		expect(chunks).toEqual([
			{ chunk_index: 0, start_offset: 0, page_start: 1, length: 4000 },
			{ chunk_index: 1, start_offset: 3700, page_start: 1, length: 4000 },
			{ chunk_index: 2, start_offset: 7400, page_start: 2, length: 894 },
		]);
		const edited = doc(db, person, "replacementword revised material", input);
		expect(edited.id).toBe(first.id);
		expect(count(db, "person_documents")).toBe(1);
		expect(count(db, "person_document_chunks")).toBe(1);
		for (const table of ["person_documents_fts", "person_chunks_fts"]) {
			expect(
				db
					.prepare(
						`select count(*) n from ${table} where ${table} match 'obsoleteword'`,
					)
					.get(),
			).toEqual({ n: 0 });
			expect(
				db
					.prepare(
						`select count(*) n from ${table} where ${table} match 'replacementword'`,
					)
					.get(),
			).toEqual({ n: 1 });
		}
		expect(count(db, "person_events")).toBe(0);
	});
	it("does not index failed extraction and rejects a source belonging to another person", () => {
		const db = setup();
		const first = createPerson(db, "First");
		const second = createPerson(db, "Second");
		const sourceId = addPersonSource(db, first, "telegram", "channel");
		expect(() =>
			doc(db, second, "Wrong owner", {
				kind: "telegram",
				sourceId,
				externalId: "1",
			}),
		).toThrow(/不匹配/);
		doc(db, first, "", { extractionStatus: "failed" });
		expect(count(db, "person_document_chunks")).toBe(0);
	});
	it("advances read positions monotonically without swallowing arrivals after a displayed snapshot", () => {
		const db = setup();
		const person = createPerson(db, "Author");
		recordPersonEvent(db, person, "tweet:1");
		const displayed = personLatestSequence(db, person);
		recordPersonEvent(db, person, "tweet:2");
		markPersonRead(db, person, displayed);
		markPersonRead(db, person, 0);
		expect(getPersonDetail(db, person).unreadCount).toBe(1);
		expect(requirePerson(db, person).read_sequence).toBe(displayed);
		expect(() =>
			markPersonRead(db, person, personLatestSequence(db, person) + 1),
		).toThrow(/无效/);
		recordPersonEvent(db, person, "tweet:2");
		expect(getPersonDetail(db, person).unreadCount).toBe(1);
	});
	it("paginates more than fifty people without duplicate rows and retains total and unread filtering", () => {
		const db = setup();
		const people = Array.from({ length: 57 }, (_, index) =>
			createPerson(db, `Author ${index}`),
		);
		for (const person of people.slice(0, 3))
			recordPersonEvent(db, person, `tweet:${person}`);
		db.prepare("update people set updated_at=?").run(publishedAt);
		const first = listPeoplePage(db);
		expect(first.people).toHaveLength(50);
		expect(first.total).toBe(57);
		expect(first.nextCursor).toBeTruthy();
		const second = listPeoplePage(db, { before: first.nextCursor! });
		expect(second.people).toHaveLength(7);
		expect(second.total).toBe(57);
		expect(second.nextCursor).toBeNull();
		expect(
			new Set([...first.people, ...second.people].map((person) => person.id))
				.size,
		).toBe(57);
		expect(listPeoplePage(db, { unread: true }).total).toBe(3);
		expect(() => listPeoplePage(db, { before: "garbage" })).toThrow(/翻页/);
	});
	it("merges source associations, original files and unread events while hiding the former person", () => {
		const db = setup();
		const from = createPerson(db, "Former", "Original biography");
		const target = createPerson(db, "Target", "Target biography");
		const sourceId = addPersonSource(db, from, "telegram", "channel");
		const original = doc(db, from, "Identical file", {
			filename: "original.txt",
			storageKey: "documents/original.txt",
			contentHash: "same-hash",
		});
		markPersonRead(db, from, personLatestSequence(db, from));
		const unread = doc(db, from, "New post", {
			kind: "telegram",
			sourceId,
			externalId: "1",
		});
		const copy = doc(db, target, "Identical file", {
			filename: "copy.txt",
			storageKey: "documents/copy.txt",
			contentHash: "same-hash",
		});
		markPersonRead(db, target, personLatestSequence(db, target));
		const asset = enqueuePersonAsset(db, {
			personId: from,
			sourceId,
			documentId: unread.id,
			remoteUrl: "https://cdn1.telesco.pe/file/p.jpg",
			kind: "image",
		});
		expect(mergePeople(db, from, target)).toBe(target);
		expect(listPeoplePage(db).people.map((person) => person.id)).toEqual([
			target,
		]);
		expect(() => requirePerson(db, from)).toThrow(/合并/);
		expect(getPersonDetail(db, target)).toMatchObject({
			unreadCount: 1,
			stats: { documents: 2, items: 3 },
		});
		expect(
			getPersonItems(db, { personId: target })
				.items.map((item) => item.id)
				.sort(),
		).toEqual(
			[`doc:${original.id}`, `doc:${unread.id}`, `doc:${copy.id}`].sort(),
		);
		expect(
			db.prepare("select person_id from person_assets where id=?").get(asset),
		).toEqual({ person_id: target });
		expect(
			db
				.prepare(
					"select storage_key from person_documents where filename is not null order by filename",
				)
				.all(),
		).toEqual([
			{ storage_key: "documents/copy.txt" },
			{ storage_key: "documents/original.txt" },
		]);
		expect(requirePerson(db, target).description).toContain(
			"Original biography",
		);
	});
});
