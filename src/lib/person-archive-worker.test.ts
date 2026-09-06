// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensurePersonArchiveTables } from "./person-archive-schema";
import {
	collectPersonTelegramSource,
	runPersonArchiveOnce,
	runPersonArchiveMediaOnce,
	startPersonArchiveWorker,
	stopPersonArchiveWorker,
} from "./person-archive-worker";
import Database from "./sqlite";
import * as archiveStore from "./person-archive-store";
import type {
	TelegramChannelPage,
	TelegramPublicPost,
} from "./telegram-channel";

const databases: Database[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	databases.splice(0).forEach((db) => db.close());
});
function setup() {
	const db = new Database(":memory:");
	databases.push(db);
	ensurePersonArchiveTables(db);
	db.prepare(
		"insert into people(id,name,created_at,updated_at) values('person','Person',?,?)",
	).run("2026-09-05T00:00:00.000Z", "2026-09-05T00:00:00.000Z");
	db.prepare(
		"insert into person_sources(id,person_id,kind,identifier,url,next_poll_at,created_at) values('source','person','telegram','channel','https://t.me/channel',?,?)",
	).run("2026-09-05T00:00:00.000Z", "2026-09-05T00:00:00.000Z");
	return db;
}
function source(db: Database) {
	return db
		.prepare("select * from person_sources where id='source'")
		.get() as Parameters<typeof collectPersonTelegramSource>[1];
}
function page(ids: number[], before: number | null): TelegramChannelPage {
	return {
		coverage: "public_web",
		before,
		posts: ids.map(
			(id): TelegramPublicPost => ({
				id,
				text: `Post ${id}`,
				publishedAt:
					id > 101 ? "2026-09-06T00:00:00.000Z" : "2020-01-01T00:00:00.000Z",
				url: `https://t.me/channel/${id}`,
				media: [],
				unsupportedMedia: false,
				textUnavailable: false,
				forwardedFrom: null,
			}),
		),
	};
}
function count(db: Database, table: string) {
	return (db.prepare(`select count(*) n from ${table}`).get() as { n: number })
		.n;
}

describe("person Telegram collection", () => {
	it("keeps separate durable history and incremental cursors through multi-page bursts", async () => {
		const db = setup();
		const fetchPage = vi
			.fn()
			.mockResolvedValueOnce(page([100, 101], 100))
			.mockResolvedValueOnce(page([105, 106], 105))
			.mockResolvedValueOnce(page([98, 99], 98))
			.mockResolvedValueOnce(page([102, 103, 104], 102))
			.mockResolvedValueOnce(page([], null))
			.mockResolvedValueOnce(page([100, 101], 100));
		await collectPersonTelegramSource(db, source(db), { fetchPage });
		expect(count(db, "person_events")).toBe(0);
		await collectPersonTelegramSource(db, source(db), { fetchPage });
		expect(JSON.parse(source(db).latest_cursor!)).toEqual({
			latest: 101,
			before: 105,
			target: 106,
		});
		expect(JSON.parse(source(db).history_cursor!)).toEqual({ before: 98 });
		await collectPersonTelegramSource(db, source(db), { fetchPage });
		await collectPersonTelegramSource(db, source(db), { fetchPage });
		expect(JSON.parse(source(db).latest_cursor!)).toEqual({ latest: 106 });
		expect(source(db).history_status).toBe("public_caught_up");
		expect(count(db, "person_documents")).toBe(9);
		expect(count(db, "person_events")).toBe(5);
		expect(fetchPage.mock.calls.map((call) => call[1]?.before)).toEqual([
			undefined,
			undefined,
			100,
			105,
			98,
			102,
		]);
	});
	it("rejects repeated history pages without advancing the durable cursor", async () => {
		const db = setup();
		await collectPersonTelegramSource(db, source(db), {
			fetchPage: vi.fn().mockResolvedValue(page([100, 101], 100)),
		});
		const fetchPage = vi
			.fn()
			.mockResolvedValueOnce(page([100, 101], 100))
			.mockResolvedValueOnce(page([100, 101], 100));
		await expect(
			collectPersonTelegramSource(db, source(db), { fetchPage }),
		).rejects.toThrow("did not advance");
		expect(JSON.parse(source(db).history_cursor!)).toEqual({ before: 100 });
		expect(count(db, "person_documents")).toBe(2);
	});
	it("refreshes signed media URLs without duplicating archived objects and preserves provenance", async () => {
		const db = setup();
		const first = page([100], null);
		first.posts[0]!.media = [
			{ kind: "image", url: "https://cdn1.telesco.pe/file/img.jpg?token=old" },
		];
		first.posts[0]!.forwardedFrom = "Another author";
		await collectPersonTelegramSource(db, source(db), {
			fetchPage: vi.fn().mockResolvedValue(first),
		});
		const second = page([100], null);
		second.posts[0]!.media = [
			{ kind: "image", url: "https://cdn1.telesco.pe/file/img.jpg?token=new" },
		];
		second.posts[0]!.forwardedFrom = "Another author";
		await collectPersonTelegramSource(db, source(db), {
			fetchPage: vi.fn().mockResolvedValue(second),
		});
		expect(count(db, "person_assets")).toBe(1);
		expect(db.prepare("select remote_url from person_assets").get()).toEqual({
			remote_url: second.posts[0]!.media[0]!.url,
		});
		const row = db.prepare("select raw_json from person_documents").get() as {
			raw_json: string;
		};
		expect(JSON.parse(row.raw_json)).toMatchObject({
			coverage: "public_web",
			attribution: "forwarded",
			forwardedFrom: "Another author",
		});
	});
	it("restarts a requested history scan without resetting the live high-water mark", async () => {
		const db = setup();
		await collectPersonTelegramSource(db, source(db), {
			fetchPage: vi.fn().mockResolvedValue(page([100, 101], null)),
		});
		db.prepare(
			"update person_sources set history_status='queued',history_cursor=null where id='source'",
		).run();
		const fetchPage = vi
			.fn()
			.mockResolvedValueOnce(page([101, 102], 101))
			.mockResolvedValueOnce(page([98, 99, 100], 98));
		await collectPersonTelegramSource(db, source(db), { fetchPage });
		expect(JSON.parse(source(db).latest_cursor!)).toEqual({ latest: 102 });
		expect(JSON.parse(source(db).history_cursor!)).toEqual({ before: 98 });
		expect(fetchPage.mock.calls.map((call) => call[1]?.before)).toEqual([
			undefined,
			101,
		]);
		expect(count(db, "person_events")).toBe(1);
	});
	it("keeps a stored media file available when Telegram rotates its remote token", async () => {
		const db = setup();
		const first = page([100], null);
		first.posts[0]!.media = [
			{
				kind: "image",
				url: "https://cdn1.telesco.pe/file/image.jpg?token=old",
			},
		];
		await collectPersonTelegramSource(db, source(db), {
			fetchPage: vi.fn().mockResolvedValue(first),
		});
		db.prepare(
			"update person_assets set status='stored',storage_key='assets/saved.jpg'",
		).run();
		const second = page([100], null);
		second.posts[0]!.media = [
			{
				kind: "image",
				url: "https://cdn1.telesco.pe/file/image.jpg?token=new",
			},
		];
		await collectPersonTelegramSource(db, source(db), {
			fetchPage: vi.fn().mockResolvedValue(second),
		});
		expect(count(db, "person_assets")).toBe(1);
		expect(
			db.prepare("select status,storage_key from person_assets").get(),
		).toEqual({ status: "stored", storage_key: "assets/saved.jpg" });
	});
	it("recognizes an initialized empty channel and notifies for its first new post", async () => {
		const db = setup();
		await collectPersonTelegramSource(db, source(db), {
			fetchPage: vi.fn().mockResolvedValue(page([], null)),
		});
		expect(JSON.parse(source(db).latest_cursor!)).toEqual({ latest: 0 });
		await collectPersonTelegramSource(db, source(db), {
			fetchPage: vi.fn().mockResolvedValue(page([102], null)),
		});
		expect(count(db, "person_events")).toBe(1);
	});
	it("collects only new media for legacy followers until history is explicitly requested", async () => {
		const db = setup();
		db.exec(`create table profiles(id text,handle text,display_name text);
		create table follow_edges(profile_id text,direction text,current integer,updated_at text);
		create table twillot_history_jobs(profile_id text,capture_status text,updated_at text);
		create table tweets(id text,author_profile_id text,media_json text,created_at text);`);
		db.prepare(
			"update person_sources set kind='x',profile_id='profile',history_status='existing_archive' where id='source'",
		).run();
		const insert = db.prepare("insert into tweets values(?,'profile',?,?)");
		insert.run(
			"old",
			JSON.stringify([
				{ type: "photo", url: "https://pbs.twimg.com/media/old.jpg" },
			]),
			"2020-01-01T00:00:00.000Z",
		);
		insert.run(
			"new",
			JSON.stringify([
				{ type: "photo", url: "https://pbs.twimg.com/media/new.jpg" },
			]),
			"2026-09-06T00:00:00.000Z",
		);
		await runPersonArchiveOnce({
			db,
			skipMedia: true,
			now: new Date("2026-09-06T00:00:00.000Z"),
		});
		expect(db.prepare("select tweet_id from person_assets").all()).toEqual([
			{ tweet_id: "new" },
		]);
		expect(db.prepare("select item_id from person_events").all()).toEqual([
			{ item_id: "tweet:new" },
		]);
	});
	it("reserves Telegram slots ahead of a large overdue X backlog", async () => {
		const db = setup();
		db.exec(`create table profiles(id text,handle text,display_name text);
		create table follow_edges(profile_id text,direction text,current integer,updated_at text);
		create table twillot_history_jobs(profile_id text,capture_status text,updated_at text);
		create table tweets(id text,author_profile_id text,media_json text,created_at text);`);
		for (let i = 0; i < 55; i++)
			db.prepare(
				"insert into person_sources(id,person_id,kind,identifier,url,profile_id,history_status,next_poll_at,created_at) values(?,'person','x',?,? ,?,'existing_archive','2020-01-01','2020-01-01')",
			).run(`x-${i}`, `author${i}`, `https://x.com/author${i}`, `profile-${i}`);
		let startedAheadOfX = false;
		const fetchPage = vi.fn().mockImplementation(() => {
			startedAheadOfX =
				(
					db
						.prepare(
							"select count(*) n from person_sources where kind='x' and last_synced_at is not null",
						)
						.get() as { n: number }
				).n === 0;
			return Promise.resolve(page([100], null));
		});
		const result = await runPersonArchiveOnce({
			db,
			skipMedia: true,
			fetchPage,
			now: new Date("2026-09-06T00:00:00.000Z"),
		});
		expect(startedAheadOfX).toBe(true);
		expect(fetchPage).toHaveBeenCalledOnce();
		expect(result.sources).toBe(51);
		expect(
			db
				.prepare(
					"select count(*) n from person_sources where kind='x' and last_synced_at is not null",
				)
				.get(),
		).toEqual({ n: 50 });
		expect(source(db).history_status).toBe("public_caught_up");
	});
	it("starts all reserved channel requests without waiting for one slow channel", async () => {
		const db = setup();
		db.exec(`create table profiles(id text,handle text,display_name text);
		create table follow_edges(profile_id text,direction text,current integer,updated_at text);
		create table twillot_history_jobs(profile_id text,capture_status text,updated_at text);
		create table tweets(id text,author_profile_id text,media_json text,created_at text);`);
		db.prepare(
			"insert into person_sources(id,person_id,kind,identifier,url,next_poll_at,created_at) values('second','person','telegram','secondchannel','https://t.me/secondchannel','2020-01-01','2020-01-01')",
		).run();
		let release: ((value: TelegramChannelPage) => void) | undefined;
		const slow = new Promise<TelegramChannelPage>((resolve) => {
			release = resolve;
		});
		const fetchPage = vi
			.fn()
			.mockImplementation((identifier: string) =>
				identifier === "secondchannel"
					? slow
					: Promise.resolve(page([100], null)),
			);
		const cycle = runPersonArchiveOnce({
			db,
			skipMedia: true,
			fetchPage,
			now: new Date("2026-09-06T00:00:00.000Z"),
		});
		expect(fetchPage).toHaveBeenCalledTimes(2);
		release!(page([100], null));
		await cycle;
		expect(source(db).history_status).toBe("public_caught_up");
	});
	it("caps unresolved X identity requests while continuing known local scans", async () => {
		const db = setup();
		db.exec(`create table profiles(id text,handle text,display_name text);
		create table follow_edges(profile_id text,direction text,current integer,updated_at text);
		create table twillot_history_jobs(profile_id text,capture_status text,updated_at text);
		create table tweets(id text,author_profile_id text,media_json text,created_at text);`);
		db.prepare("update person_sources set enabled=0 where id='source'").run();
		for (let i = 0; i < 3; i++)
			db.prepare(
				"insert into person_sources(id,person_id,kind,identifier,url,next_poll_at,created_at) values(?,'person','x',?,?,'2020-01-01','2020-01-01')",
			).run(`unknown-${i}`, `unknown${i}`, `https://x.com/unknown${i}`);
		const resolve = vi
			.spyOn(archiveStore, "queuePersonXSource")
			.mockRejectedValue(new Error("Test provider unavailable"));
		await runPersonArchiveOnce({
			db,
			skipMedia: true,
			now: new Date("2026-09-06T00:00:00.000Z"),
		});
		expect(resolve).toHaveBeenCalledOnce();
		expect(
			db
				.prepare(
					"select count(*) n from person_sources where last_error is not null",
				)
				.get(),
		).toEqual({ n: 1 });
	});
	it("keeps the source timer responsive while a separate singleton media download is waiting", async () => {
		const db = setup();
		db.exec(`create table profiles(id text,handle text,display_name text);
		create table follow_edges(profile_id text,direction text,current integer,updated_at text);
		create table twillot_history_jobs(profile_id text,capture_status text,updated_at text);
		create table tweets(id text,author_profile_id text,media_json text,created_at text);`);
		db.prepare(
			"insert into person_assets(id,person_id,source_id,remote_url,kind,status,next_attempt_at,created_at) values('asset','person','source','https://pbs.twimg.com/media/waiting.jpg','image','pending','2020-01-01','2020-01-01')",
		).run();
		const rootDir = mkdtempSync(
			path.join(os.tmpdir(), "birdclaw-independent-media-"),
		);
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-06T00:00:00.000Z"));
		let started: () => void = () => {};
		const began = new Promise<void>((resolve) => {
			started = resolve;
		});
		const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => reject(new DOMException("Aborted", "AbortError")),
						{ once: true },
					);
					started();
				}),
		);
		const media = runPersonArchiveMediaOnce({ db, rootDir, fetchImpl });
		try {
			await began;
			expect(
				(await runPersonArchiveMediaOnce({ db, rootDir, fetchImpl })).skipped,
			).toBe(true);
			const fetchPage = vi.fn().mockResolvedValue(page([100], null));
			startPersonArchiveWorker({ db, skipMedia: true, fetchPage });
			await vi.advanceTimersByTimeAsync(10_000);
			expect(fetchPage).toHaveBeenCalledOnce();
			db.prepare(
				"insert into person_sources(id,person_id,kind,identifier,url,next_poll_at,created_at) values('second','person','telegram','secondchannel','https://t.me/secondchannel','2020-01-01','2020-01-01')",
			).run();
			await vi.advanceTimersByTimeAsync(15_000);
			expect(fetchPage).toHaveBeenCalledTimes(2);
			expect(fetchImpl).toHaveBeenCalledOnce();
			expect(
				db.prepare("select status from person_assets where id='asset'").get(),
			).toEqual({ status: "retry" });
		} finally {
			stopPersonArchiveWorker();
			await media;
			vi.useRealTimers();
			rmSync(rootDir, { recursive: true, force: true });
		}
		expect(
			db
				.prepare("select attempts,status from person_assets where id='asset'")
				.get(),
		).toEqual({ attempts: 0, status: "retry" });
	});
});
