import { createHash } from "node:crypto";
import { mkdir, open, rename, rm, statfs } from "node:fs/promises";
import path from "node:path";
import { getBirdclawPaths } from "./config";
import type { Database } from "./sqlite";
import { allowedPersonMediaUrl } from "./telegram-channel";

const MAX_ASSET_BYTES = 100 * 1024 * 1024;
const MIME_EXTENSIONS: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
	"image/gif": "gif",
	"video/mp4": "mp4",
	"video/webm": "webm",
	"audio/mpeg": "mp3",
	"audio/mp4": "m4a",
	"audio/ogg": "ogg",
};
type AssetRow = { id: string; remote_url: string; attempts: number };

export function personArchiveAssetPath(
	storageKey: string,
	rootDir = getBirdclawPaths().rootDir,
) {
	if (!/^assets\/[a-f0-9]{64}\.[a-z0-9]{2,5}$/.test(storageKey))
		throw new Error("Invalid person asset storage key");
	return path.join(rootDir, "person-archive", storageKey);
}

export async function downloadPersonAsset(
	asset: { id: string; remote_url: string },
	options: {
		fetchImpl?: typeof fetch;
		rootDir?: string;
		maxBytes?: number;
		signal?: AbortSignal;
	} = {},
) {
	options.signal?.throwIfAborted();
	if (!allowedPersonMediaUrl(asset.remote_url))
		throw new Error("Media host is not supported for cloud archiving");
	const maxBytes = options.maxBytes ?? MAX_ASSET_BYTES;
	const assetsDir = path.join(
		options.rootDir ?? getBirdclawPaths().rootDir,
		"person-archive",
		"assets",
	);
	await mkdir(assetsDir, { recursive: true });
	const disk = await statfs(assetsDir);
	if (disk.bavail * disk.bsize < maxBytes + 256 * 1024 * 1024)
		throw new Error(
			"Cloud media storage has insufficient free space; retry later",
		);
	options.signal?.throwIfAborted();
	const controller = new AbortController();
	const abort = () => controller.abort(options.signal?.reason);
	options.signal?.addEventListener("abort", abort, { once: true });
	const timeout = setTimeout(() => controller.abort(), 45_000);
	let temporaryPath: string | undefined;
	try {
		let url = asset.remote_url;
		let response: Response | undefined;
		for (let redirect = 0; redirect <= 2; redirect++) {
			response = await (options.fetchImpl ?? fetch)(url, {
				redirect: "manual",
				signal: controller.signal,
				headers: { "user-agent": "BirdClaw/1.0 media-archive" },
			});
			if (![301, 302, 303, 307, 308].includes(response.status)) break;
			const location = response.headers.get("location");
			await response.body?.cancel();
			if (!location || redirect === 2)
				throw new Error("Media redirect limit reached");
			url = new URL(location, url).href;
			if (!allowedPersonMediaUrl(url))
				throw new Error("Media redirected to an unsupported host");
		}
		if (!response?.ok) {
			await response?.body?.cancel();
			throw new Error(`Media download returned HTTP ${response?.status ?? 0}`);
		}
		const mimeType =
			response.headers
				.get("content-type")
				?.split(";")[0]
				?.trim()
				.toLowerCase() ?? "";
		const extension = MIME_EXTENSIONS[mimeType];
		if (!extension) {
			await response.body?.cancel();
			throw new Error("Media content type is not supported");
		}
		if (Number(response.headers.get("content-length")) > maxBytes) {
			await response.body?.cancel();
			throw new Error("Media exceeds the file size limit");
		}
		if (!response.body) throw new Error("Media download has no body");
		const storageKey = `assets/${createHash("sha256").update(asset.id).digest("hex")}.${extension}`;
		const destination = personArchiveAssetPath(storageKey, options.rootDir);
		await mkdir(path.dirname(destination), { recursive: true });
		temporaryPath = `${destination}.part`;
		const file = await open(temporaryPath, "w", 0o600);
		const reader = response.body.getReader();
		let byteSize = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				byteSize += value.byteLength;
				if (byteSize > maxBytes)
					throw new Error("Media exceeds the file size limit");
				await file.writeFile(value);
			}
		} catch (error) {
			await reader.cancel().catch(() => {});
			throw error;
		} finally {
			reader.releaseLock();
			await file.close();
		}
		if (byteSize === 0) throw new Error("Media download was empty");
		await rename(temporaryPath, destination);
		temporaryPath = undefined;
		return { storageKey, mimeType, byteSize };
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", abort);
		if (temporaryPath) await rm(temporaryPath, { force: true }).catch(() => {});
	}
}

export async function runPersonMediaBatch(
	db: Database,
	options: {
		fetchImpl?: typeof fetch;
		rootDir?: string;
		limit?: number;
		now?: Date;
		signal?: AbortSignal;
	} = {},
) {
	const now = options.now ?? new Date();
	const rows = db
		.prepare(
			`select a.id,a.remote_url,a.attempts from person_assets a join person_sources s on s.id=a.source_id where s.enabled=1 and a.status in ('pending','retry') and a.next_attempt_at <= ? order by a.next_attempt_at,a.created_at limit ?`,
		)
		.all(now.toISOString(), Math.min(10, options.limit ?? 2)) as AssetRow[];
	let archived = 0;
	for (const row of rows) {
		if (options.signal?.aborted) break;
		if (
			!(
				db
					.prepare(
						"select s.enabled from person_assets a join person_sources s on s.id=a.source_id where a.id=?",
					)
					.get(row.id) as { enabled: number } | undefined
			)?.enabled
		)
			continue;
		// Advancing the retry time before I/O leaves work recoverable after a process crash.
		const claimed = db
			.prepare(
				"update person_assets set status='retry',attempts=attempts+1,next_attempt_at=? where id=? and remote_url=? and attempts=? and status in ('pending','retry') and next_attempt_at<=?",
			)
			.run(
				new Date(now.getTime() + 5 * 60_000).toISOString(),
				row.id,
				row.remote_url,
				row.attempts,
				now.toISOString(),
			);
		if (!claimed.changes) continue;
		try {
			const result = await downloadPersonAsset(row, options);
			const stored = db
				.prepare(
					"update person_assets set status='stored',storage_key=?,mime_type=?,byte_size=?,last_error=null where id=? and remote_url=? and status='retry' and attempts=?",
				)
				.run(
					result.storageKey,
					result.mimeType,
					result.byteSize,
					row.id,
					row.remote_url,
					row.attempts + 1,
				);
			archived += stored.changes;
		} catch (error) {
			if (options.signal?.aborted) {
				db.prepare(
					"update person_assets set status='retry',attempts=?,last_error='Media archive paused; retry scheduled',next_attempt_at=? where id=? and remote_url=? and status='retry' and attempts=?",
				).run(
					row.attempts,
					new Date(now.getTime() + 60_000).toISOString(),
					row.id,
					row.remote_url,
					row.attempts + 1,
				);
				break;
			}
			const message =
				error instanceof Error ? error.message : "Media download failed";
			const permanent =
				/not supported|unsupported|size limit|HTTP (403|404|410)/.test(message);
			const exhausted = row.attempts >= 4;
			db.prepare(
				"update person_assets set status=?,last_error=?,next_attempt_at=? where id=? and remote_url=? and status='retry' and attempts=?",
			).run(
				permanent || exhausted ? "unavailable" : "retry",
				message.replace(/https?:\/\/\S+/g, "[remote URL]").slice(0, 300),
				new Date(
					now.getTime() +
						Math.min(6 * 60 * 60_000, 60_000 * 2 ** (row.attempts + 1)),
				).toISOString(),
				row.id,
				row.remote_url,
				row.attempts + 1,
			);
		}
	}
	return { processed: rows.length, archived };
}
