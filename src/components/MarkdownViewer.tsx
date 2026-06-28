import type { ReactNode } from "react";
import { cx } from "#/lib/ui";
import {
	buildLookup,
	type CitationContext,
	renderInline,
	trimBullet,
} from "./MarkdownCitations";

export function MarkdownViewer({
	markdown,
	context,
	className,
	sourceOnlyCitations = false,
}: {
	markdown: string;
	context?: CitationContext | null;
	className?: string;
	sourceOnlyCitations?: boolean;
}) {
	const lookup = buildLookup(context, {
		linkReadableCitationText: !sourceOnlyCitations,
	});
	const normalizedMarkdown = markdown.replace(
		/\]\s*\r?\n\s*\((https?:\/\/[^\s)]+)\)/g,
		"]($1)",
	);
	const lines = normalizedMarkdown.split(/\r?\n/);
	const nodes: ReactNode[] = [];
	let listItems: ReactNode[][] = [];

	const flushList = () => {
		if (listItems.length === 0) return;
		nodes.push(
			<ul
				className="my-2.5 flex list-disc flex-col gap-1.5 pl-5 first:mt-0 marker:text-[var(--ink-soft)]"
				key={`list-${String(nodes.length)}`}
			>
				{listItems.map((item, index) => (
					<li key={String(index)}>{item}</li>
				))}
			</ul>,
		);
		listItems = [];
	};

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) {
			flushList();
			continue;
		}
		if (trimmed.startsWith("### ")) {
			flushList();
			nodes.push(
				<h3
					className="mt-5 mb-1.5 text-[14px] font-bold uppercase tracking-wide text-[var(--ink-soft)] first:mt-0"
					key={`h3-${String(nodes.length)}`}
				>
					{renderInline(trimmed.slice(4), lookup)}
				</h3>,
			);
			continue;
		}
		if (trimmed.startsWith("## ")) {
			flushList();
			nodes.push(
				<h2
					className="mt-6 mb-2 text-[18px] font-bold text-[var(--ink)] first:mt-0"
					key={`h2-${String(nodes.length)}`}
				>
					{renderInline(trimmed.slice(3), lookup)}
				</h2>,
			);
			continue;
		}
		if (trimmed.startsWith("# ")) {
			flushList();
			nodes.push(
				<h1
					className="mt-0 mb-2.5 text-[20px] font-bold text-[var(--ink)]"
					key={`h1-${String(nodes.length)}`}
				>
					{renderInline(trimmed.slice(2), lookup)}
				</h1>,
			);
			continue;
		}
		if (/^[-*]\s+/.test(trimmed)) {
			listItems.push(renderInline(trimBullet(trimmed), lookup));
			continue;
		}
		flushList();
		nodes.push(
			<p
				className="my-2.5 whitespace-pre-wrap first:mt-0 [overflow-wrap:anywhere]"
				key={`p-${String(nodes.length)}`}
			>
				{renderInline(trimmed, lookup)}
			</p>,
		);
	}
	flushList();

	return (
		<article
			className={cx(
				"max-w-none px-4 py-3 text-[15px] leading-[1.55] text-[var(--ink)]",
				className,
			)}
		>
			{nodes}
		</article>
	);
}
