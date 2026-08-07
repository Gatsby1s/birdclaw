import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, StickyNote } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { fetchJson } from "#/lib/api-client";
import { xRemarkSyncStatusSchema } from "#/lib/api-contracts";
import { queryKeys } from "#/lib/query-client";
import { cx, primaryButtonClass, secondaryButtonClass } from "#/lib/ui";
import { XRemarkAnnotationCard } from "./XRemarkAnnotation";

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
}: {
	handle: string;
	identifier?: string;
	remark: string;
	description: string;
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
		setSaveError(null);
		setEditing(true);
	}

	async function submitRemark() {
		setSaving(true);
		setSaveError(null);
		try {
			const status = await saveProfileRemark({
				handle,
				identifier,
				remark: remarkDraft,
				description: descriptionDraft,
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
						Both BirdClaw edits are kept when X Remark syncs.
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
