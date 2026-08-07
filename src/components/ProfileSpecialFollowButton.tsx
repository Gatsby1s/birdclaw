import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Star } from "lucide-react";
import { useState } from "react";
import { fetchJson } from "#/lib/api-client";
import { profilePriorityStatusSchema } from "#/lib/api-contracts";
import { queryKeys } from "#/lib/query-client";
import { cx, secondaryButtonClass } from "#/lib/ui";

async function fetchProfileStatus(handle: string, identifier?: string) {
	const url = new URL("/api/profile-priority", window.location.origin);
	url.searchParams.set("handle", handle);
	if (identifier) url.searchParams.set("identifier", identifier);
	return fetchJson(
		url,
		undefined,
		profilePriorityStatusSchema,
		"Special-follow status unavailable",
	);
}

async function saveSpecialFollow({
	handle,
	identifier,
	specialFollow,
}: {
	handle: string;
	identifier?: string;
	specialFollow: boolean;
}) {
	return fetchJson(
		"/api/profile-priority",
		{
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				handle,
				...(identifier ? { identifier } : {}),
				specialFollow,
			}),
		},
		profilePriorityStatusSchema,
		"Special follow could not be saved",
	);
}

export function ProfileSpecialFollowButton({
	handle,
	identifier,
	className,
}: {
	handle: string;
	identifier?: string;
	className?: string;
}) {
	const queryClient = useQueryClient();
	const queryKey = [
		...queryKeys.profilePriority,
		handle,
		identifier ?? "",
	] as const;
	const statusQuery = useQuery({
		queryKey,
		queryFn: () => fetchProfileStatus(handle, identifier),
		enabled: Boolean(handle),
	});
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const specialFollow = statusQuery.data?.specialFollow ?? false;

	async function toggleSpecialFollow() {
		setSaving(true);
		setSaveError(null);
		try {
			const status = await saveSpecialFollow({
				handle,
				identifier,
				specialFollow: !specialFollow,
			});
			queryClient.setQueryData(queryKey, status);
			await queryClient.invalidateQueries({
				queryKey: queryKeys.profilePriority,
			});
		} catch (error) {
			setSaveError(
				error instanceof Error
					? error.message
					: "Special follow could not be saved",
			);
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className={cx("flex flex-col items-start gap-1.5", className)}>
			<button
				aria-pressed={specialFollow}
				className={cx(
					secondaryButtonClass,
					specialFollow &&
						"border-[var(--accent)] bg-[var(--bg-active)] text-[var(--accent)]",
				)}
				disabled={statusQuery.isPending || saving}
				onClick={() => void toggleSpecialFollow()}
				title="Prioritize this author's posts in Today AI"
				type="button"
			>
				{statusQuery.isPending || saving ? (
					<Loader2 aria-hidden="true" className="size-4 animate-spin" />
				) : (
					<Star
						aria-hidden="true"
						className="size-4"
						fill={specialFollow ? "currentColor" : "none"}
						strokeWidth={1.9}
					/>
				)}
				{specialFollow ? "Special following" : "Special follow"}
			</button>
			{saveError || statusQuery.isError ? (
				<p aria-live="polite" className="m-0 text-[12px] text-[var(--alert)]">
					{saveError ??
						(statusQuery.error instanceof Error
							? statusQuery.error.message
							: "Special-follow status unavailable")}
				</p>
			) : null}
		</div>
	);
}
