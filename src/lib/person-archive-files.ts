import { execFile } from "node:child_process";
import { mkdir, open, rename, rm, statfs, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { getBirdclawPaths } from "./config";
import type { Database } from "./sqlite";
import {
	personContentHash,
	personDocumentItem,
	requirePerson,
	upsertPersonDocument,
	type PersonDocumentRow,
} from "./person-archive-store";

export const PERSON_FILE_MAX_BYTES = 20 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 8 * 1024 * 1024;
const runFile = promisify(execFile);
let uploading = false;
export class PersonFileError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}
export function personStoragePath(key: string) {
	if (!/^(?:assets|documents)\/[a-zA-Z0-9_-]+\.[a-z0-9]{1,10}$/.test(key))
		throw new PersonFileError("无效的文件位置。");
	return path.join(getBirdclawPaths().rootDir, "person-archive", key);
}
export async function readBoundedPersonBody(
	request: Request,
	maxBytes: number,
) {
	const size = Number(request.headers.get("content-length") ?? 0);
	if (size > maxBytes) throw new PersonFileError("上传内容超出大小限制。", 413);
	if (!request.body) throw new PersonFileError("请求没有内容。");
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const part = await reader.read();
			if (part.done) break;
			total += part.value.length;
			if (total > maxBytes) {
				await reader.cancel();
				throw new PersonFileError("上传内容超出大小限制。", 413);
			}
			chunks.push(part.value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks, total);
}
export function normalizeDocumentDate(value: string | undefined) {
	if (!value) return new Date().toISOString();
	if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value))
		throw new PersonFileError("资料日期格式无效。");
	const date = new Date(value);
	if (!Number.isFinite(date.getTime()))
		throw new PersonFileError("资料日期格式无效。");
	return date.toISOString();
}
function sourceUrl(value: string) {
	if (!value.trim()) return null;
	const url = new URL(value);
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password
	)
		throw new PersonFileError("原始资料链接需为 HTTP 或 HTTPS。");
	return url.toString();
}
export async function uploadPersonFile(db: Database, request: Request) {
	if (uploading)
		throw new PersonFileError("另一份资料正在解析，请稍后重试。", 429);
	uploading = true;
	try {
		const body = await readBoundedPersonBody(
			request,
			PERSON_FILE_MAX_BYTES + 128 * 1024,
		);
		const form = await new Response(body, {
			headers: { "content-type": request.headers.get("content-type") ?? "" },
		}).formData();
		const personId = String(form.get("personId") ?? "");
		requirePerson(db, personId);
		const file = form.get("file");
		if (!(file instanceof File) || file.size === 0)
			throw new PersonFileError("请选择非空 PDF 或文字文件。");
		if (file.size > PERSON_FILE_MAX_BYTES)
			throw new PersonFileError("每份文件最多 20 MiB。", 413);
		const filename = path
			.basename(file.name.replaceAll("\\", "/"))
			.replace(/[\r\n\x00-\x1f]/g, "")
			.slice(0, 240);
		const ext = path.extname(filename).toLowerCase();
		if (![".pdf", ".txt", ".md", ".csv", ".json"].includes(ext))
			throw new PersonFileError("支持 PDF、TXT、Markdown、CSV 和 JSON 文件。");
		const bytes = Buffer.from(await file.arrayBuffer());
		if (
			ext === ".pdf" &&
			!bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"))
		)
			throw new PersonFileError("文件内容不是有效的 PDF。");
		const hash = personContentHash(bytes);
		const existing = db
			.prepare(
				"select * from person_documents where person_id=? and kind='document' and content_hash=?",
			)
			.get(personId, hash) as PersonDocumentRow | undefined;
		if (existing) return personDocumentItem(db, existing);
		const title =
			String(form.get("title") ?? "")
				.trim()
				.slice(0, 240) || filename;
		const publishedAt = normalizeDocumentDate(
			String(form.get("publishedAt") ?? "") || undefined,
		);
		const originalUrl = sourceUrl(String(form.get("sourceUrl") ?? ""));
		const key = `documents/${randomUUID()}${ext}`;
		const destination = personStoragePath(key);
		await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
		const fs = await statfs(path.dirname(destination));
		if (Number(fs.bavail) * Number(fs.bsize) < bytes.length + 256 * 1024 * 1024)
			throw new PersonFileError("云端可用空间不足，文件尚未保存。", 507);
		const temp = `${destination}.partial`;
		await writeFile(temp, bytes, { mode: 0o600 });
		await rename(temp, destination);
		let text = "";
		let extractionStatus = "indexed";
		let error: string | null = null;
		try {
			if (ext === ".pdf") {
				const result = await runFile(
					"pdftotext",
					["-layout", "-enc", "UTF-8", destination, "-"],
					{ timeout: 30_000, maxBuffer: MAX_EXTRACTED_BYTES, encoding: "utf8" },
				);
				text = result.stdout
					.replaceAll("\u0000", "")
					.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
				if (!text.trim()) extractionStatus = "needs_ocr";
			} else {
				text = new TextDecoder("utf-8", { fatal: true })
					.decode(bytes)
					.replaceAll("\u0000", "")
					.trim();
				if (Buffer.byteLength(text) > MAX_EXTRACTED_BYTES)
					throw new Error("extracted_text_too_large");
				if (!text) extractionStatus = "failed";
			}
		} catch {
			extractionStatus = "failed";
			error =
				"原件已保存；文字解析失败（文件编码、加密或解析资源限制），可重新上传可复制文字的版本。";
		}
		try {
			const inserted = upsertPersonDocument(db, {
				personId,
				kind: "document",
				title,
				text,
				publishedAt,
				sourceUrl: originalUrl,
				filename,
				mimeType:
					ext === ".pdf" ? "application/pdf" : "text/plain; charset=utf-8",
				storageKey: key,
				byteSize: bytes.length,
				extractionStatus,
				contentHash: hash,
				rawJson: {
					extractionError: error,
					sourcePlatform: "uploaded",
					uploadedAt: new Date().toISOString(),
				},
			});
			return personDocumentItem(
				db,
				db
					.prepare("select * from person_documents where id=?")
					.get(inserted.id) as PersonDocumentRow,
			);
		} catch (error) {
			await rm(destination, { force: true });
			throw error;
		}
	} finally {
		uploading = false;
	}
}
export async function downloadPersonFile(
	db: Database,
	id: string,
	request: Request,
) {
	const document = db
		.prepare(
			"select storage_key,mime_type,filename from person_documents where id=? and kind='document'",
		)
		.get(id) as
		| { storage_key: string | null; mime_type: string | null; filename: string }
		| undefined;
	const asset = document
		? undefined
		: (db
				.prepare(
					"select storage_key,mime_type from person_assets where id=? and status='stored'",
				)
				.get(id) as
				| { storage_key: string | null; mime_type: string | null }
				| undefined);
	const record = document ?? asset;
	if (!record?.storage_key)
		return new Response("File not found", { status: 404 });
	const absolute = personStoragePath(record.storage_key);
	let size: number;
	try {
		const fd = await open(absolute, "r");
		try {
			size = (await fd.stat()).size;
		} finally {
			await fd.close();
		}
	} catch {
		return new Response("File unavailable", { status: 404 });
	}
	const safeMime = document
		? "application/octet-stream"
		: /^(image\/(jpeg|png|webp|gif)|video\/(mp4|webm)|audio\/(mpeg|ogg|mp4))$/.test(
					record.mime_type ?? "",
			  )
			? record.mime_type!
			: "application/octet-stream";
	const headers: Record<string, string> = {
		"content-type": safeMime,
		"x-content-type-options": "nosniff",
		"cache-control": "private, max-age=300",
		"accept-ranges": "bytes",
		"content-security-policy": "default-src 'none'; sandbox",
	};
	if (document)
		headers["content-disposition"] =
			`attachment; filename*=UTF-8''${encodeURIComponent(document.filename)}`;
	const range = request.headers.get("range");
	let start = 0;
	let end = size - 1;
	let status = 200;
	if (range) {
		const match = /^bytes=(\d*)-(\d*)$/.exec(range);
		if (!match || (!match[1] && !match[2]))
			return new Response(null, {
				status: 416,
				headers: { "content-range": `bytes */${size}` },
			});
		if (match[1]) {
			start = Number(match[1]);
			end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
		} else {
			start = Math.max(0, size - Number(match[2]));
		}
		if (
			!Number.isSafeInteger(start) ||
			!Number.isSafeInteger(end) ||
			start > end ||
			start >= size
		)
			return new Response(null, {
				status: 416,
				headers: { "content-range": `bytes */${size}` },
			});
		status = 206;
		headers["content-range"] = `bytes ${start}-${end}/${size}`;
	}
	headers["content-length"] = String(end - start + 1);
	if (request.method === "HEAD") return new Response(null, { status, headers });
	const stream = Readable.toWeb(
		createReadStream(absolute, { start, end }),
	) as ReadableStream<Uint8Array>;
	return new Response(stream, { status, headers });
}
