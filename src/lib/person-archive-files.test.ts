// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import {
	downloadPersonFile,
	normalizeDocumentDate,
	PERSON_FILE_MAX_BYTES,
	personStoragePath,
	readBoundedPersonBody,
	uploadPersonFile,
} from "./person-archive-files";
import { ensurePersonArchiveTables } from "./person-archive-schema";
import { createPerson } from "./person-archive-store";
import Database from "./sqlite";

const roots: string[] = [];
const databases: Database[] = [];
const originalHome = process.env.BIRDCLAW_HOME;
afterEach(async () => {
	for (const db of databases.splice(0)) db.close();
	resetBirdclawPathsForTests();
	if (originalHome === undefined) delete process.env.BIRDCLAW_HOME;
	else process.env.BIRDCLAW_HOME = originalHome;
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});
async function setup() {
	const root = await mkdtemp(path.join(os.tmpdir(), "birdclaw-person-files-"));
	roots.push(root);
	process.env.BIRDCLAW_HOME = root;
	resetBirdclawPathsForTests();
	const db = new Database(":memory:");
	databases.push(db);
	ensurePersonArchiveTables(db);
	return { db, root, personId: createPerson(db, "Archive author") };
}
function request(
	personId: string,
	bytes: string | Uint8Array,
	filename: string,
	extra: Record<string, string> = {},
) {
	const form = new FormData();
	form.set("personId", personId);
	form.set(
		"file",
		new File(
			[typeof bytes === "string" ? bytes : new Uint8Array(bytes)],
			filename,
		),
	);
	for (const [key, value] of Object.entries(extra)) form.set(key, value);
	return new Request("https://birdclaw.test/api/person-files", {
		method: "POST",
		body: form,
	});
}
function record(db: Database, itemId: string) {
	return db
		.prepare("select * from person_documents where id=?")
		.get(itemId.replace(/^doc:/, "")) as {
		id: string;
		storage_key: string;
		extraction_status: string;
		text: string;
		raw_json: string;
		byte_size: number;
		filename: string;
	};
}
function minimalPdf(text: string) {
	const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
	];
	let pdf = "%PDF-1.4\n";
	const offsets = [0];
	objects.forEach((object, index) => {
		offsets.push(Buffer.byteLength(pdf));
		pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
	});
	const xref = Buffer.byteLength(pdf);
	pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
		.slice(1)
		.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
		.join("")}trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${xref}\n%%EOF\n`;
	return pdf;
}
const hasPdfText =
	spawnSync("pdftotext", ["-v"], { stdio: "ignore" }).status === 0;

describe("person file ingestion and download", () => {
	it("saves UTF-8 originals, searchable text and a single document when uploaded twice", async () => {
		const { db, root, personId } = await setup();
		const first = await uploadPersonFile(
			db,
			request(
				personId,
				"人物原话\nSearchable archive notes",
				"../../notes.txt",
				{
					title: "Collected notes",
					publishedAt: "2025-01-02",
					sourceUrl: "https://example.com/article",
				},
			),
		);
		const second = await uploadPersonFile(
			db,
			request(personId, "人物原话\nSearchable archive notes", "duplicate.txt"),
		);
		expect(second.id).toBe(first.id);
		expect(first.text).toContain("人物原话");
		expect(first.publishedAt).toBe("2025-01-02T00:00:00.000Z");
		const stored = record(db, first.id);
		expect(stored.filename).toBe("notes.txt");
		expect(await readFile(personStoragePath(stored.storage_key), "utf8")).toBe(
			"人物原话\nSearchable archive notes",
		);
		expect(
			await readdir(path.join(root, "person-archive/documents")),
		).toHaveLength(1);
		expect(
			db
				.prepare(
					"select count(*) n from person_chunks_fts where person_chunks_fts match 'Searchable'",
				)
				.get(),
		).toEqual({ n: 1 });
	});
	it.skipIf(!hasPdfText)(
		"extracts a real text PDF and retains the original file",
		async () => {
			const { db, personId } = await setup();
			const pdf = minimalPdf("Verified PDF archive material");
			const item = await uploadPersonFile(
				db,
				request(personId, pdf, "reference.pdf"),
			);
			expect(item.text).toContain("Verified PDF archive material");
			expect(item.ragStatus).toBe("indexed");
			expect(
				await readFile(
					personStoragePath(record(db, item.id).storage_key),
					"utf8",
				),
			).toBe(pdf);
			expect(
				db.prepare("select count(*) n from person_document_chunks").get(),
			).toEqual({ n: 1 });
		},
	);
	it("retains a damaged PDF as failed extraction without pretending it is searchable", async () => {
		const { db, personId } = await setup();
		const pdf = "%PDF-1.4\ntruncated damaged document\n";
		const item = await uploadPersonFile(
			db,
			request(personId, pdf, "damaged.pdf"),
		);
		expect(item.ragStatus).toBe("failed");
		expect(item.text).toBe("");
		const stored = record(db, item.id);
		expect(await readFile(personStoragePath(stored.storage_key), "utf8")).toBe(
			pdf,
		);
		expect(JSON.parse(stored.raw_json).extractionError).toContain("原件已保存");
		expect(
			db.prepare("select count(*) n from person_document_chunks").get(),
		).toEqual({ n: 0 });
	});
	it("preserves an undecodable text original while marking extraction failed", async () => {
		const { db, personId } = await setup();
		const bytes = new Uint8Array([0xff, 0xfe, 0xff]);
		const item = await uploadPersonFile(
			db,
			request(personId, bytes, "encoding.txt"),
		);
		expect(item.ragStatus).toBe("failed");
		expect(
			await readFile(personStoragePath(record(db, item.id).storage_key)),
		).toEqual(Buffer.from(bytes));
	});
	it("rejects a fake PDF and unsupported files before storing a document", async () => {
		const { db, personId } = await setup();
		await expect(
			uploadPersonFile(db, request(personId, "not a PDF", "fake.pdf")),
		).rejects.toThrow(/有效的 PDF/);
		await expect(
			uploadPersonFile(
				db,
				request(personId, "<script>bad</script>", "script.html"),
			),
		).rejects.toThrow(/支持 PDF/);
		expect(db.prepare("select count(*) n from person_documents").get()).toEqual(
			{ n: 0 },
		);
	});
	it("enforces declared and actual streamed request limits", async () => {
		const declared = new Request("https://birdclaw.test/upload", {
			method: "POST",
			body: "x",
			headers: { "content-length": String(PERSON_FILE_MAX_BYTES + 1) },
		});
		await expect(
			readBoundedPersonBody(declared, PERSON_FILE_MAX_BYTES),
		).rejects.toMatchObject({ status: 413 });
		const actual = new Request("https://birdclaw.test/upload", {
			method: "POST",
			body: "12345",
		});
		await expect(readBoundedPersonBody(actual, 4)).rejects.toMatchObject({
			status: 413,
		});
	});
	it("downloads exact ranges, suffixes and HEAD metadata with safe attachment headers", async () => {
		const { db, personId } = await setup();
		const item = await uploadPersonFile(
			db,
			request(personId, "0123456789", '中文"notes.txt'),
		);
		const id = item.id.slice(4);
		const ranged = await downloadPersonFile(
			db,
			id,
			new Request("https://birdclaw.test/file", {
				headers: { range: "bytes=2-5" },
			}),
		);
		expect(ranged.status).toBe(206);
		expect(ranged.headers.get("content-range")).toBe("bytes 2-5/10");
		expect(await ranged.text()).toBe("2345");
		expect(ranged.headers.get("content-type")).toBe("application/octet-stream");
		expect(ranged.headers.get("x-content-type-options")).toBe("nosniff");
		expect(ranged.headers.get("content-disposition")).toContain(
			"attachment; filename*=UTF-8''",
		);
		const suffix = await downloadPersonFile(
			db,
			id,
			new Request("https://birdclaw.test/file", {
				headers: { range: "bytes=-3" },
			}),
		);
		expect(await suffix.text()).toBe("789");
		const head = await downloadPersonFile(
			db,
			id,
			new Request("https://birdclaw.test/file", { method: "HEAD" }),
		);
		expect(head.status).toBe(200);
		expect(head.headers.get("content-length")).toBe("10");
		expect(await head.text()).toBe("");
	});
	it("rejects invalid ranges and unavailable files", async () => {
		const { db, personId } = await setup();
		const item = await uploadPersonFile(
			db,
			request(personId, "0123456789", "notes.txt"),
		);
		const id = item.id.slice(4);
		for (const range of [
			"bytes=10-",
			"bytes=8-3",
			"bytes=-0",
			"bytes=0-1,4-5",
			"bytes=-",
		]) {
			const response = await downloadPersonFile(
				db,
				id,
				new Request("https://birdclaw.test/file", { headers: { range } }),
			);
			expect(response.status).toBe(416);
			expect(response.headers.get("content-range")).toBe("bytes */10");
		}
		expect(
			(
				await downloadPersonFile(
					db,
					"missing",
					new Request("https://birdclaw.test/file"),
				)
			).status,
		).toBe(404);
		await rm(personStoragePath(record(db, item.id).storage_key));
		expect(
			(
				await downloadPersonFile(
					db,
					id,
					new Request("https://birdclaw.test/file"),
				)
			).status,
		).toBe(404);
	});
	it("rejects path traversal and malformed document dates", () => {
		for (const key of [
			"../secret.txt",
			"documents/../../secret.txt",
			"documents/%2e%2e.txt",
			"/tmp/secret.txt",
		])
			expect(() => personStoragePath(key)).toThrow(/无效/);
		expect(normalizeDocumentDate("2026-09-06")).toBe(
			"2026-09-06T00:00:00.000Z",
		);
		expect(() => normalizeDocumentDate("not a date")).toThrow(/无效/);
	});
});
