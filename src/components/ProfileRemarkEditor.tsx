import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Pencil, Plus, StickyNote, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { fetchJson } from "#/lib/api-client";
import { xRemarkSyncStatusSchema } from "#/lib/api-contracts";
import { queryKeys } from "#/lib/query-client";
import { cx, primaryButtonClass, secondaryButtonClass } from "#/lib/ui";
import { XRemarkAnnotationCard } from "./XRemarkAnnotation";

const QUICK_PROFILE_TAGS = ["交易员", "分析师"] as const;

function normalizedTags(tags: string[]) {
	const result: string[] = [];
	const seen = new Set<string>();
	for (const value of tags) {
		const tag = value.trim();
		const key = tag.toLocaleLowerCase();
		if (!tag || seen.has(key)) continue;
		seen.add(key);
		result.push(tag);
	}
	return result.slice(0, 200);
}

async function fetchProfileRemark(handle: string, identifier?: string) {
	const url = new URL("/api/xremark", window.location.origin);
	url.searchParams.set("handle", handle);
	if (identifier) url.searchParams.set("identifier", identifier);
	return fetchJson(
		url,
		undefined,
		xRemarkSyncStatusSchema,
		"Private note unavailable",
	);
}

async function saveProfileRemark({
	handle,
	identifier,
	remark,
	description,
	tags,
}: {
	handle: string;
	identifier?: string;
	remark: string;
	description: string;
	tags: string[];
}) {
	return fetchJson(
		"/api/xremark",
		{
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				handle,
				...(identifier ? { identifier } : {}),
				remark,
				description,
				tags,
			}),
		},
		xRemarkSyncStatusSchema,
		"Private note could not be saved",
	);
}

export function ProfileRemarkEditor({
	handle,
	identifier,
	className,
}: {
	handle: string;
	identifier?: string;
	className?: string;
}) {
	const queryClient = useQueryClient();
	const queryKey = [...queryKeys.xRemark, handle, identifier ?? ""] as const;
	const noteQuery = useQuery({
		queryKey,
		queryFn: () => fetchProfileRemark(handle, identifier),
		enabled: Boolean(handle),
	});
	const [editing, setEditing] = useState(false);
	const [remarkDraft, setRemarkDraft] = useState("");
	const [descriptionDraft, setDescriptionDraft] = useState("");
	const [tagsDraft, setTagsDraft] = useState<string[]>([]);
	const [tagInput, setTagInput] = useState("");
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const annotation = noteQuery.data?.annotation;

	useEffect(() => {
		if (editing) textareaRef.current?.focus();
	}, [editing]);

	function beginEditing() {
		setRemarkDraft(annotation?.remark ?? "");
		setDescriptionDraft(annotation?.description ?? "");
		setTagsDraft([...(annotation?.tags ?? [])]);
		setTagInput("");
		setSaveError(null);
		setEditing(true);
	}

	async function submitRemark() {
		setSaving(true);
		setSaveError(null);
		try {
			const tags = normalizedTags([
				...tagsDraft,
				...(tagInput.trim() ? [tagInput] : []),
			]);
			const status = await saveProfileRemark({
				handle,
				identifier,
				remark: remarkDraft,
				description: descriptionDraft,
				tags,
			});
			queryClient.setQueryData(queryKey, status);
			setEditing(false);
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: queryKeys.xRemark }),
				queryClient.invalidateQueries({ queryKey: queryKeys.timelines }),
			]);
		} catch (error) {
			setSaveError(
				error instanceof Error
					? error.message
					: "Private note could not be saved",
			);
		} finally {
			setSaving(false);
		}
	}

	function addTag(value = tagInput) {
		const tag = value.trim();
		if (!tag) return;
		if (tagsDraft.length >= 200) {
			setSaveError("A note can have at most 200 tags.");
			return;
		}
		setTagsDraft((current) => normalizedTags([...current, tag]));
		setTagInput("");
		setSaveError(null);
	}

	function removeTag(tag: string) {
		setTagsDraft((current) => current.filter((value) => value !== tag));
	}

	function toggleQuickTag(tag: string) {
		if (tagsDraft.includes(tag)) removeTag(tag);
		else addTag(tag);
	}

	return (
		<section
			aria-label={`Private note for @${handle}`}
			className={cx("max-w-2xl", className)}
		>
			{editing ? (
				<div className="rounded-xl border border-[var(--line)] bg-[var(--bg-elevated)] p-3">
					<div className="flex items-center gap-2 text-[13px] font-bold text-[var(--ink)]">
						<StickyNote
							aria-hidden="true"
							className="size-4 text-[var(--accent)]"
							strokeWidth={1.9}
						/>
						Private notes for @{handle}
					</div>
					<label className="mt-3 flex flex-col gap-2">
						<span className="flex items-center gap-2 text-[13px] font-bold text-[var(--ink)]">
							Remark
						</span>
						<textarea
							aria-label="Remark"
							className="min-h-20 w-full resize-y rounded-lg border border-[var(--line-strong)] bg-[var(--bg)] px-3 py-2.5 text-[15px] leading-[1.45] text-[var(--ink)] outline-none focus:border-[var(--accent)] focus:shadow-[0_0_0_1px_var(--accent)]"
							maxLength={80}
							onChange={(event) => setRemarkDraft(event.currentTarget.value)}
							placeholder="Add a short remark about this person"
							ref={textareaRef}
							value={remarkDraft}
						/>
						<span className="self-end text-[11px] text-[var(--ink-soft)]">
							{String(remarkDraft.length)}/80
						</span>
					</label>
					<fieldset className="mt-3 min-w-0 border-0 p-0">
						<legend className="text-[13px] font-bold text-[var(--ink)]">
							Tags
						</legend>
						<div className="mt-2 flex flex-wrap gap-2" aria-label="Quick tags">
							{QUICK_PROFILE_TAGS.map((tag) => {
								const selected = tagsDraft.includes(tag);
								return (
									<button
										aria-pressed={selected}
										className={cx(
											"inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-[13px] font-bold outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
											selected
												? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
												: "border-[var(--line-strong)] bg-[var(--bg)] text-[var(--ink)] hover:bg-[var(--bg-hover)]",
										)}
										onClick={() => toggleQuickTag(tag)}
										type="button"
									>
										{selected ? (
											<Check aria-hidden="true" className="size-3.5" />
										) : null}
										{tag}
									</button>
								);
							})}
						</div>
						{tagsDraft.length > 0 ? (
							<div
								className="mt-2 flex flex-wrap gap-2"
								aria-label="Selected tags"
							>
								{tagsDraft.map((tag) => (
									<span
										className="inline-flex min-h-9 items-center gap-1 rounded-full bg-[var(--bg-subtle)] pl-3 pr-1 text-[13px] text-[var(--ink)]"
										key={tag}
									>
										#{tag}
										<button
											aria-label={`Remove tag ${tag}`}
											className="inline-flex size-8 items-center justify-center rounded-full text-[var(--ink-soft)] outline-none hover:bg-[var(--bg-hover)] hover:text-[var(--ink)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
											onClick={() => removeTag(tag)}
											type="button"
										>
											<X aria-hidden="true" className="size-3.5" />
										</button>
									</span>
								))}
							</div>
						) : null}
						<div className="mt-2 flex min-w-0 gap-2">
							<input
								aria-label="Custom tag"
								className="min-h-11 min-w-0 flex-1 rounded-lg border border-[var(--line-strong)] bg-[var(--bg)] px-3 text-[14px] text-[var(--ink)] outline-none focus:border-[var(--accent)] focus:shadow-[0_0_0_1px_var(--accent)]"
								maxLength={200}
								onChange={(event) => setTagInput(event.currentTarget.value)}
								onKeyDown={(event) => {
									if (event.key !== "Enter") return;
									event.preventDefault();
									addTag();
								}}
								placeholder="Add a custom tag"
								value={tagInput}
							/>
							<button
								className={cx(secondaryButtonClass, "min-h-11 shrink-0")}
								disabled={!tagInput.trim()}
								onClick={() => addTag()}
								type="button"
							>
								<Plus aria-hidden="true" className="size-4" />
								Add
							</button>
						</div>
					</fieldset>
					<label className="mt-3 flex flex-col gap-2">
						<span className="text-[13px] font-bold text-[var(--ink)]">
							Description
						</span>
						<textarea
							aria-label="Description"
							className="min-h-28 w-full resize-y rounded-lg border border-[var(--line-strong)] bg-[var(--bg)] px-3 py-2.5 text-[15px] leading-[1.45] text-[var(--ink)] outline-none focus:border-[var(--accent)] focus:shadow-[0_0_0_1px_var(--accent)]"
							maxLength={300}
							onChange={(event) =>
								setDescriptionDraft(event.currentTarget.value)
							}
							placeholder="Add more detailed context or background"
							value={descriptionDraft}
						/>
						<span className="self-end text-[11px] text-[var(--ink-soft)]">
							{String(descriptionDraft.length)}/300
						</span>
					</label>
					<p className="mb-0 mt-1 text-[11px] text-[var(--ink-soft)]">
						{noteQuery.data?.bidirectionalEligible === false
							? "This profile has no stable X ID yet. Its note stays in BirdClaw until it can be linked."
							: "Notes and tags sync both ways with X Remark on X."}
					</p>
					{saveError ? (
						<p
							aria-live="polite"
							className="mb-0 mt-2 text-[13px] text-[var(--alert)]"
						>
							{saveError}
						</p>
					) : null}
					<div className="mt-3 flex justify-end gap-2">
						<button
							className={secondaryButtonClass}
							disabled={saving}
							onClick={() => setEditing(false)}
							type="button"
						>
							Cancel
						</button>
						<button
							className={primaryButtonClass}
							disabled={saving}
							onClick={() => void submitRemark()}
							type="button"
						>
							{saving ? "Saving…" : "Save note"}
						</button>
					</div>
				</div>
			) : (
				<div className="flex flex-col gap-2">
					{annotation ? (
						<XRemarkAnnotationCard annotation={annotation} />
					) : noteQuery.isError ? (
						<p className="m-0 text-[13px] text-[var(--alert)]">
							{noteQuery.error instanceof Error
								? noteQuery.error.message
								: "Private note unavailable"}
						</p>
					) : null}
					<button
						className={cx(secondaryButtonClass, "self-start")}
						disabled={noteQuery.isPending}
						onClick={beginEditing}
						type="button"
					>
						<Pencil aria-hidden="true" className="size-4" strokeWidth={1.9} />
						{noteQuery.isPending
							? "Loading note…"
							: annotation
								? "Edit note"
								: "Add note"}
					</button>
				</div>
			)}
		</section>
	);
}
