import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
	dailyDigestPdfPath,
	getPeriodDigestHistory,
	intradayDigestPdfPath,
	type PeriodDigestHistoryDetail,
} from "./period-digest-history";
import {
	getWeeklyDigestHistory,
	weeklyDigestPdfPath,
	type WeeklyDigestHistoryDetail,
} from "./weekly-digest-history";

const execFilePromise = promisify(execFile);
const renders = new Map<string, Promise<string>>();
type DigestHistoryDetail =
	| PeriodDigestHistoryDetail
	| WeeklyDigestHistoryDetail;

const CHROME_CANDIDATES = [
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
	"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
];

function chromeExecutable() {
	const configured = process.env.BIRDCLAW_CHROME_PATH?.trim();
	if (configured && existsSync(configured)) return configured;
	return CHROME_CANDIDATES.find(existsSync);
}

async function validPdf(filePath: string) {
	try {
		const handle = await fs.open(filePath, "r");
		try {
			const stats = await handle.stat();
			if (stats.size < 1_000) return false;
			const header = Buffer.alloc(5);
			await handle.read(header, 0, header.length, 0);
			return header.toString("ascii") === "%PDF-";
		} finally {
			await handle.close();
		}
	} catch {
		return false;
	}
}

function pdfFingerprint(detail: DigestHistoryDetail) {
	return createHash("sha256")
		.update(
			JSON.stringify({
				kind: detail.metadata.kind,
				date: detail.metadata.date,
				updatedAt: detail.metadata.updatedAt,
				contextHash: detail.result.context.hash,
				digest: detail.result.digest,
				markdown: detail.result.markdown,
			}),
		)
		.digest("hex");
}

function pdfMetadataPath(filePath: string) {
	return `${filePath}.meta.json`;
}

async function validCachedPdf(filePath: string, detail: DigestHistoryDetail) {
	if (!(await validPdf(filePath))) return false;
	try {
		const raw = await fs.readFile(pdfMetadataPath(filePath), "utf8");
		const metadata = JSON.parse(raw) as { fingerprint?: unknown };
		return metadata.fingerprint === pdfFingerprint(detail);
	} catch {
		return false;
	}
}

async function writePdfCacheMetadata(
	filePath: string,
	detail: DigestHistoryDetail,
) {
	const metadataPath = pdfMetadataPath(filePath);
	const temporaryPath = `${metadataPath}.${String(process.pid)}.${String(Date.now())}.tmp`;
	await fs.writeFile(
		temporaryPath,
		`${JSON.stringify({ fingerprint: pdfFingerprint(detail) })}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);
	await fs.rename(temporaryPath, metadataPath);
	await fs.chmod(metadataPath, 0o600);
}

function escapeHtml(value: string) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function markdownLines(markdown: string) {
	return markdown
		.split("\n")
		.map((line) => {
			const heading = /^(#{1,3})\s+(.+)$/.exec(line);
			if (heading) {
				const level = Math.min(3, heading[1]?.length ?? 2);
				return `<h${String(level)}>${escapeHtml(heading[2] ?? "")}</h${String(level)}>`;
			}
			const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
			if (bullet)
				return `<div class="bullet">${escapeHtml(bullet[1] ?? "")}</div>`;
			return line.trim()
				? `<p>${escapeHtml(line)}</p>`
				: '<div class="space"></div>';
		})
		.join("\n");
}

function dailyDigestHtml(detail: DigestHistoryDetail) {
	const { metadata, result } = detail;
	const weekly = metadata.kind === "weekly";
	const intraday = metadata.kind === "intraday";
	const archiveLabel = weekly
		? "Weekly archive"
		: intraday
			? "Intraday overview"
			: "Daily archive";
	const dateLabel = weekly
		? `${metadata.date} – ${metadata.endDate}`
		: intraday
			? `${metadata.date} · ${metadata.slotLabel ?? "8-hour window"}`
			: metadata.date;
	const footerLabel = weekly ? "weekly" : intraday ? "intraday" : "daily";
	return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(metadata.title)}</title>
<style>
@page { size: A4; margin: 18mm 17mm 20mm; }
* { box-sizing: border-box; }
body { margin: 0; color: #18202a; font: 13px/1.58 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
header { border-bottom: 2px solid #1d9bf0; margin-bottom: 24px; padding-bottom: 16px; }
.brand { color: #1d9bf0; font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
h1 { font-size: 27px; line-height: 1.18; margin: 8px 0 10px; }
h2 { font-size: 20px; line-height: 1.25; margin: 26px 0 9px; break-after: avoid; }
h3 { font-size: 15px; line-height: 1.35; margin: 18px 0 6px; break-after: avoid; }
p { margin: 4px 0; white-space: pre-wrap; }
.meta { color: #5c6978; font-size: 11px; }
.summary { color: #334155; font-size: 14px; margin-top: 10px; }
.bullet { margin: 6px 0 6px 17px; text-indent: -12px; }
.bullet::before { content: "• "; color: #1d9bf0; font-weight: 700; }
.space { height: 7px; }
footer { border-top: 1px solid #d9e0e7; color: #738092; font-size: 10px; margin-top: 28px; padding-top: 10px; }
</style></head><body>
<header><div class="brand">BirdClaw · ${archiveLabel}</div><h1>${escapeHtml(metadata.title)}</h1>
<div class="meta">${escapeHtml(dateLabel)} · ${escapeHtml(metadata.timezone)} · ${escapeHtml(result.provider ?? "openai")} / ${escapeHtml(result.model)}</div>
<div class="summary">${escapeHtml(metadata.summary)}</div></header>
<main>${markdownLines(result.markdown)}</main>
<footer>Saved ${footerLabel} history · Restoring and downloading this report uses 0 model tokens.</footer>
</body></html>`;
}

async function renderDailyDigestPdf({
	date,
	detail,
}: {
	date: string;
	detail: DigestHistoryDetail;
}) {
	const chrome = chromeExecutable();
	if (!chrome) {
		throw new Error(
			"Google Chrome, Microsoft Edge, or Chromium is required for direct PDF downloads",
		);
	}
	const target =
		detail.metadata.kind === "weekly"
			? weeklyDigestPdfPath(date)
			: detail.metadata.kind === "intraday"
				? intradayDigestPdfPath(detail.metadata.archiveKey)
				: dailyDigestPdfPath(date);
	if (await validCachedPdf(target, detail)) return target;
	const profileDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "birdclaw-daily-pdf-profile-"),
	);
	const temporaryPdf = path.join(profileDir, "digest.pdf");
	const reportHtml = path.join(profileDir, "report.html");
	try {
		await fs.writeFile(reportHtml, dailyDigestHtml(detail), {
			encoding: "utf8",
			mode: 0o600,
		});
		await execFilePromise(
			chrome,
			[
				"--headless=new",
				"--disable-gpu",
				"--no-first-run",
				"--no-default-browser-check",
				"--disable-extensions",
				"--hide-scrollbars",
				"--print-to-pdf-no-header",
				"--no-pdf-header-footer",
				"--run-all-compositor-stages-before-draw",
				"--virtual-time-budget=20000",
				"--window-size=1280,1600",
				`--user-data-dir=${profileDir}`,
				`--print-to-pdf=${temporaryPdf}`,
				pathToFileURL(reportHtml).href,
			],
			{ timeout: 45_000, maxBuffer: 1_000_000 },
		);
		if (!(await validPdf(temporaryPdf))) {
			throw new Error("The daily digest PDF renderer returned an invalid file");
		}
		await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
		await fs.rename(temporaryPdf, target);
		await fs.chmod(target, 0o600);
		await writePdfCacheMetadata(target, detail);
		return target;
	} finally {
		await fs.rm(profileDir, { recursive: true, force: true });
	}
}

export async function ensureDailyDigestPdf({ id }: { id: string }) {
	const detail = getPeriodDigestHistory(id);
	if (!detail) throw new Error("Daily digest history not found");
	const target =
		detail.metadata.kind === "intraday"
			? intradayDigestPdfPath(detail.metadata.archiveKey)
			: dailyDigestPdfPath(detail.metadata.date);
	if (await validCachedPdf(target, detail)) return target;
	const existing = renders.get(id);
	if (existing) return existing;
	const render = renderDailyDigestPdf({
		date: detail.metadata.archiveKey,
		detail,
	}).finally(() => renders.delete(id));
	renders.set(id, render);
	return render;
}

export async function ensureWeeklyDigestPdf({ id }: { id: string }) {
	const detail = getWeeklyDigestHistory(id);
	if (!detail) throw new Error("Weekly digest history not found");
	const target = weeklyDigestPdfPath(detail.metadata.date);
	if (await validCachedPdf(target, detail)) return target;
	const renderKey = `weekly:${id}`;
	const existing = renders.get(renderKey);
	if (existing) return existing;
	const render = renderDailyDigestPdf({
		date: detail.metadata.date,
		detail,
	}).finally(() => renders.delete(renderKey));
	renders.set(renderKey, render);
	return render;
}

export const __test__ = {
	chromeExecutable,
	dailyDigestHtml,
	renderDailyDigestPdf,
	pdfFingerprint,
	validCachedPdf,
	validPdf,
	writePdfCacheMetadata,
};
