// @vitest-environment node
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	downloadPersonAsset,
	personArchiveAssetPath,
	runPersonMediaBatch,
} from "./person-media";

import Database from "./sqlite";
const databases: Database[] = [];
const roots: string[] = [];
afterEach(async () => {
	for (const db of databases.splice(0)) db.close();
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});
async function testRoot() {
	const root = await mkdtemp(path.join(os.tmpdir(), "birdclaw-person-media-"));
	roots.push(root);
	return root;
}

describe("person media archive", () => {
	it("persists media bytes atomically under a safe deterministic storage key", async () => {
		const rootDir = await testRoot();
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(Buffer.from([1, 2, 3]), {
				headers: { "content-type": "image/jpeg" },
			}),
		);
		const result = await downloadPersonAsset(
			{ id: "asset-id", remote_url: "https://pbs.twimg.com/media/example.jpg" },
			{ fetchImpl, rootDir },
		);
		expect(result).toMatchObject({ mimeType: "image/jpeg", byteSize: 3 });
		expect(
			await readFile(personArchiveAssetPath(result.storageKey, rootDir)),
		).toEqual(Buffer.from([1, 2, 3]));
		expect(
			await readdir(path.join(rootDir, "person-archive/assets")),
		).toHaveLength(1);
	});
	it("rejects an untrusted redirect before requesting it", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(null, {
				status: 302,
				headers: { location: "http://127.0.0.1/secrets" },
			}),
		);
		await expect(
			downloadPersonAsset(
				{ id: "id", remote_url: "https://pbs.twimg.com/media/x.jpg" },
				{ fetchImpl },
			),
		).rejects.toThrow("unsupported host");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});
	it("enforces streamed size limits and removes partial files", async () => {
		const rootDir = await testRoot();
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(Buffer.from([1, 2, 3]), {
				headers: { "content-type": "image/jpeg" },
			}),
		);
		await expect(
			downloadPersonAsset(
				{ id: "id", remote_url: "https://pbs.twimg.com/media/x.jpg" },
				{ fetchImpl, rootDir, maxBytes: 2 },
			),
		).rejects.toThrow("size limit");
		expect(await readdir(path.join(rootDir, "person-archive/assets"))).toEqual(
			[],
		);
	});
	it("rejects executable content and path traversal", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
			new Response("<html>bad</html>", {
				headers: { "content-type": "text/html" },
			}),
		);
		await expect(
			downloadPersonAsset(
				{ id: "id", remote_url: "https://pbs.twimg.com/media/x.jpg" },
				{ fetchImpl },
			),
		).rejects.toThrow("content type");
		expect(() => personArchiveAssetPath("assets/../../secret")).toThrow(
			"Invalid person asset storage key",
		);
	});
	it("cancels active media on shutdown without exhausting retry attempts or starting another file", async () => {
		const rootDir = await testRoot();
		const db = new Database(":memory:");
		databases.push(db);
		db.exec(`create table person_sources(id text,enabled integer);
		create table person_assets(id text,source_id text,remote_url text,attempts integer,status text,next_attempt_at text,created_at text,storage_key text,mime_type text,byte_size integer,last_error text);
		insert into person_sources values('source',1);`);
		const insert = db.prepare(
			"insert into person_assets(id,source_id,remote_url,attempts,status,next_attempt_at,created_at) values(?,'source',?,0,'pending','2020-01-01','2020-01-01')",
		);
		insert.run("first", "https://pbs.twimg.com/media/first.jpg");
		insert.run("second", "https://pbs.twimg.com/media/second.jpg");
		const controller = new AbortController();
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
		const batch = runPersonMediaBatch(db, {
			rootDir,
			fetchImpl,
			signal: controller.signal,
		});
		await began;
		controller.abort();
		await batch;
		expect(fetchImpl).toHaveBeenCalledOnce();
		expect(
			db
				.prepare("select status,attempts from person_assets where id='first'")
				.get(),
		).toEqual({ status: "retry", attempts: 0 });
		expect(
			db
				.prepare("select status,attempts from person_assets where id='second'")
				.get(),
		).toEqual({ status: "pending", attempts: 0 });
	});
	it("does not let an old download failure disable a newly refreshed signed URL", async () => {
		const rootDir = await testRoot();
		const db = new Database(":memory:");
		databases.push(db);
		db.exec(`create table person_sources(id text,enabled integer);
		create table person_assets(id text,source_id text,remote_url text,attempts integer,status text,next_attempt_at text,created_at text,storage_key text,mime_type text,byte_size integer,last_error text);
		insert into person_sources values('source',1);`);
		const original = "https://cdn1.telesco.pe/file/p.jpg?token=old";
		const refreshed = "https://cdn1.telesco.pe/file/p.jpg?token=new";
		db.prepare(
			"insert into person_assets(id,source_id,remote_url,attempts,status,next_attempt_at,created_at) values('asset','source',?,0,'pending','2020-01-01','2020-01-01')",
		).run(original);
		let started: () => void = () => {};
		const began = new Promise<void>((resolve) => {
			started = resolve;
		});
		let finish: ((response: Response) => void) | undefined;
		const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
					started();
				}),
		);
		const batch = runPersonMediaBatch(db, { rootDir, fetchImpl });
		await began;
		db.prepare(
			"update person_assets set remote_url=?,status='pending',attempts=0,next_attempt_at='2026-09-06' where id='asset'",
		).run(refreshed);
		finish!(new Response(null, { status: 403 }));
		await batch;
		expect(
			db
				.prepare(
					"select status,attempts,remote_url,last_error from person_assets where id='asset'",
				)
				.get(),
		).toEqual({
			status: "pending",
			attempts: 0,
			remote_url: refreshed,
			last_error: null,
		});
	});
});
