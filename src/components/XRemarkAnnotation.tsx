import { StickyNote } from "lucide-react";
import type { XRemarkAnnotation } from "#/lib/types";
import { cx } from "#/lib/ui";

function annotationLabel(annotation: XRemarkAnnotation) {
	return `X Remark note for @${annotation.handle}`;
}

function truncateAnnotationText(value: string, limit: number) {
	if (value.length <= limit) return value;
	return `${value.slice(0, limit).trimEnd()}…`;
}

function AnnotationTags({
	annotation,
	compact,
}: {
	annotation: XRemarkAnnotation;
	compact: boolean;
}) {
	if (!annotation.category && annotation.tags.length === 0) return null;
	const tags = compact ? annotation.tags.slice(0, 6) : annotation.tags;
	return (
		<span className="flex flex-wrap gap-1.5">
			{annotation.category ? (
				<span className="rounded-full border border-[var(--line)] px-2 py-0.5 text-[11px] font-bold text-[var(--ink-soft)]">
					{annotation.category}
				</span>
			) : null}
			{tags.map((tag) => (
				<span
					key={tag}
					className="rounded-full bg-[var(--bg-active)] px-2 py-0.5 text-[11px] text-[var(--ink-soft)]"
				>
					#{tag}
				</span>
			))}
			{tags.length < annotation.tags.length ? (
				<span className="px-1 py-0.5 text-[11px] text-[var(--ink-soft)]">
					+{String(annotation.tags.length - tags.length)}
				</span>
			) : null}
		</span>
	);
}

export function XRemarkAnnotationCard({
	annotation,
	className = "",
	compact = false,
}: {
	annotation: XRemarkAnnotation;
	className?: string;
	compact?: boolean;
}) {
	const remark = compact
		? truncateAnnotationText(annotation.remark, 280)
		: annotation.remark;
	const description = compact
		? truncateAnnotationText(annotation.description, 480)
		: annotation.description;
	return (
		<div
			aria-label={annotationLabel(annotation)}
			className={cx(
				"flex gap-2 rounded-lg border border-[color:color-mix(in_srgb,var(--accent)_28%,var(--line))] bg-[color:color-mix(in_srgb,var(--accent)_6%,var(--bg))] px-3 py-2 text-[13px]",
				className,
			)}
			data-testid="xremark-annotation"
		>
			<StickyNote
				aria-hidden="true"
				className="mt-0.5 size-4 shrink-0 text-[var(--accent)]"
				strokeWidth={1.9}
			/>
			<div className="min-w-0 space-y-1">
				<div className="text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--ink-soft)]">
					X Remark
				</div>
				{remark ? (
					<div className="whitespace-pre-wrap font-semibold text-[var(--ink)] [overflow-wrap:anywhere]">
						{remark}
					</div>
				) : null}
				{description ? (
					<div className="whitespace-pre-wrap text-[var(--ink-soft)] [overflow-wrap:anywhere]">
						{description}
					</div>
				) : null}
				<AnnotationTags annotation={annotation} compact={compact} />
			</div>
		</div>
	);
}

export function XRemarkAnnotationInline({
	annotation,
}: {
	annotation: XRemarkAnnotation;
}) {
	const primary =
		annotation.remark ||
		annotation.description ||
		annotation.category ||
		annotation.tags.map((tag) => `#${tag}`).join(" ");
	const summary = truncateAnnotationText(
		annotation.remark && annotation.description
			? `${primary} · ${annotation.description}`
			: primary,
		240,
	);
	return (
		<span
			aria-label={annotationLabel(annotation)}
			className="flex gap-1.5 rounded-md border border-[var(--line)] bg-[var(--bg-active)] px-2 py-1.5 text-[12px] text-[var(--ink)]"
			data-testid="xremark-annotation-inline"
		>
			<StickyNote
				aria-hidden="true"
				className="mt-0.5 size-3.5 shrink-0 text-[var(--accent)]"
				strokeWidth={1.9}
			/>
			<span className="min-w-0 [overflow-wrap:anywhere]">{summary}</span>
		</span>
	);
}
