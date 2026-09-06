import { useState } from "react";
import { ExternalLink, FileText } from "lucide-react";
import type { PersonItem } from "#/lib/person-archive-types";
import { secondaryButtonClass } from "#/lib/ui";

export function safeArchiveUrl(value: string | null | undefined) {
	if (!value) return undefined;
	if (value.startsWith("/api/person-files?") && !value.startsWith("//"))
		return value;
	try {
		const url = new URL(value);
		return ["https:", "http:"].includes(url.protocol) ? value : undefined;
	} catch {
		return undefined;
	}
}

export function PersonArchiveItem({ item }: { item: PersonItem }) {
	const [expanded, setExpanded] = useState(false);
	const [showMedia, setShowMedia] = useState(false);
	const sourceUrl = safeArchiveUrl(item.sourceUrl);
	const documentUrl = safeArchiveUrl(item.document?.downloadUrl);
	const long = item.text.length > 1600;
	return (
		<article className="border-b border-[var(--line)] px-5 py-5 sm:px-7">
			<div className="flex flex-wrap items-center gap-2 text-xs text-[var(--ink-soft)]">
				<span className="rounded border border-[var(--line)] px-1.5 py-0.5 font-semibold">
					{item.kind === "x"
						? "X / Twitter"
						: item.kind === "telegram"
							? "Telegram"
							: "历史资料"}
				</span>
				<time dateTime={item.publishedAt}>
					{new Date(item.publishedAt).toLocaleString("zh-CN", {
						timeZone: "Asia/Singapore",
					})}
				</time>
				{item.ragStatus === "ready" || item.ragStatus === "indexed" ? (
					<span>已建立索引</span>
				) : (
					<span>
						索引：
						{(
							{
								pending: "处理中",
								needs_ocr: "需要文字识别",
								failed: "处理失败",
								media_only: "仅有媒体，暂无可索引文字",
								unavailable: "原始内容暂不可用",
							} as Record<string, string>
						)[item.ragStatus] ?? "状态待核对"}
					</span>
				)}
			</div>
			{item.title && (
				<h3 className="mt-3 break-words text-base font-bold">{item.title}</h3>
			)}
			{item.attribution &&
				item.attribution !== "channel" &&
				item.attribution !== "forwarded" && (
					<p className="mt-2 text-xs text-[var(--ink-soft)]">
						来源署名：{item.attribution}
					</p>
				)}
			{item.kind === "telegram" &&
				(!item.attribution || item.attribution === "channel") && (
					<p className="mt-2 text-xs text-[var(--ink-soft)]">
						频道发布 · 未单独核实作者
					</p>
				)}
			{item.kind === "telegram" && item.attribution === "forwarded" && (
				<p className="mt-2 text-xs text-[var(--ink-soft)]">
					频道转发 · 原作者以来源为准
				</p>
			)}
			<p className="mt-3 whitespace-pre-wrap break-words text-[15px] leading-relaxed [overflow-wrap:anywhere]">
				{long && !expanded ? `${item.text.slice(0, 1600)}…` : item.text}
			</p>
			{long && (
				<button
					type="button"
					onClick={() => setExpanded(!expanded)}
					className="mt-2 text-sm font-semibold text-[var(--accent)]"
				>
					{expanded ? "收起正文" : item.textTruncated ? "展开预览" : "展开全文"}
				</button>
			)}
			{item.textTruncated && (
				<p className="mt-2 text-xs leading-relaxed text-[var(--ink-soft)]">
					此处显示正文预览，完整内容可打开原始文件；检索包含已提取全文。
				</p>
			)}
			{item.document && (
				<div className="mt-4 rounded-xl border border-[var(--line)] p-3">
					<div className="flex items-center gap-2 text-sm">
						<FileText size={18} />
						<span className="break-all">{item.document.filename}</span>
					</div>
					<p className="mt-1 text-xs text-[var(--ink-soft)]">
						文字提取：
						{(
							{
								ready: "完成",
								indexed: "完成",
								extracted: "完成",
								pending: "处理中",
								failed: "失败",
								needs_ocr: "需要 OCR",
								media_only: "仅有媒体，暂无可提取文字",
								unavailable: "原始内容暂不可用",
								empty: "未提取到文字",
							} as Record<string, string>
						)[item.document.extractionStatus] ?? "状态待核对"}
					</p>
					{documentUrl && (
						<a
							className="mt-2 inline-block text-sm text-[var(--accent)]"
							href={documentUrl}
							target="_blank"
							rel="noreferrer"
						>
							打开原始文件
						</a>
					)}
				</div>
			)}
			{item.media.length > 0 && (
				<div className="mt-4">
					<button
						type="button"
						className={secondaryButtonClass}
						onClick={() => setShowMedia(!showMedia)}
					>
						{showMedia ? "收起媒体" : `查看 ${item.media.length} 个媒体资源`}
					</button>
					{showMedia && (
						<div className="mt-3 grid gap-3 sm:grid-cols-2">
							{item.media.map((media) => {
								const url = safeArchiveUrl(media.url);
								return (
									<div
										key={media.id}
										className="min-w-0 rounded-xl border border-[var(--line)] p-2"
									>
										{url && media.mimeType?.startsWith("image/") ? (
											<a href={url} target="_blank" rel="noreferrer">
												<img
													alt="存档图片"
													loading="lazy"
													src={url}
													className="max-h-96 w-full rounded-lg object-contain"
												/>
											</a>
										) : url && media.mimeType?.startsWith("video/") ? (
											<video
												controls
												playsInline
												preload="none"
												className="max-h-96 w-full"
												src={url}
											/>
										) : url && media.mimeType?.startsWith("audio/") ? (
											<audio
												controls
												preload="none"
												className="w-full"
												src={url}
											/>
										) : url ? (
											<a
												className="text-sm text-[var(--accent)]"
												href={url}
												target="_blank"
												rel="noreferrer"
											>
												打开媒体文件
											</a>
										) : (
											<p className="text-xs text-[var(--ink-soft)]">
												{(
													{
														unavailable: "无法取得原件，可在来源中重试",
														retry: "等待重试",
														failed: "媒体保存失败，等待重试",
														pending: "待保存",
													} as Record<string, string>
												)[media.storageStatus] ?? "媒体状态待核对"}
											</p>
										)}
									</div>
								);
							})}
						</div>
					)}
				</div>
			)}
			{sourceUrl && (
				<a
					href={sourceUrl}
					target="_blank"
					rel="noreferrer"
					className="mt-4 inline-flex items-center gap-1 text-xs text-[var(--accent)]"
				>
					<ExternalLink size={13} />
					查看来源
				</a>
			)}
		</article>
	);
}
