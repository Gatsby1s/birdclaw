import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ListPlus, Loader2 } from "lucide-react";
import { fetchJson, fetchQueryEnvelope } from "#/lib/api-client";
import { profileListMembershipStatusSchema } from "#/lib/api-contracts";
import { queryKeys } from "#/lib/query-client";
import { cx, secondaryButtonClass } from "#/lib/ui";
import { useSelectedAccountId } from "./account-selection";

async function fetchMemberships(
	accountId: string,
	handle: string,
	identifier?: string,
) {
	const url = new URL("/api/list-members", window.location.origin);
	url.searchParams.set("account", accountId);
	url.searchParams.set("profileHandle", handle);
	if (identifier) url.searchParams.set("identifier", identifier);
	return fetchJson(
		url,
		undefined,
		profileListMembershipStatusSchema,
		"Lists unavailable",
	);
}

async function saveMembership(input: {
	accountId: string;
	listId: string;
	handle: string;
	identifier?: string;
	included: boolean;
}) {
	const response = await fetch("/api/list-members", {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
	});
	if (!response.ok) throw new Error("List membership could not be saved");
}

export function ProfileListsButton({
	handle,
	identifier,
	className,
}: {
	handle: string;
	identifier?: string;
	className?: string;
}) {
	const queryClient = useQueryClient();
	const statusQuery = useQuery({
		queryKey: queryKeys.status,
		queryFn: ({ signal }) => fetchQueryEnvelope({ signal }),
	});
	const accountId = useSelectedAccountId(statusQuery.data?.accounts);
	const membershipKey = [
		...queryKeys.profileListMembers,
		accountId ?? "none",
		handle.toLowerCase(),
		identifier ?? "",
	] as const;
	const memberships = useQuery({
		queryKey: membershipKey,
		queryFn: () => fetchMemberships(accountId as string, handle, identifier),
		enabled: Boolean(accountId && handle),
	});
	const mutation = useMutation({
		mutationFn: saveMembership,
		onSuccess: async () => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: membershipKey }),
				queryClient.invalidateQueries({ queryKey: queryKeys.profileLists }),
				queryClient.invalidateQueries({
					queryKey: queryKeys.profileListMembers,
				}),
				queryClient.invalidateQueries({ queryKey: queryKeys.profileListFeed }),
			]);
		},
	});
	const includedCount =
		memberships.data?.lists.filter((list) => list.included).length ?? 0;

	return (
		<details className={cx("group relative w-fit", className)}>
			<summary
				className={cx(
					secondaryButtonClass,
					"min-h-11 cursor-pointer list-none",
					includedCount > 0 &&
						"border-[var(--accent)] bg-[var(--bg-active)] text-[var(--accent)]",
				)}
			>
				{memberships.isPending || mutation.isPending ? (
					<Loader2 aria-hidden="true" className="size-4 animate-spin" />
				) : (
					<ListPlus aria-hidden="true" className="size-4" strokeWidth={1.9} />
				)}
				{includedCount > 0
					? `已加入 ${String(includedCount)} 个列表`
					: "加入列表"}
			</summary>
			<div className="absolute left-0 top-[calc(100%+0.5rem)] z-40 w-[min(82vw,300px)] rounded-2xl border border-[var(--line-strong)] bg-[var(--bg-elevated)] p-2 shadow-[0_16px_50px_var(--shadow-strong)]">
				{memberships.data?.lists.length ? (
					<div className="flex max-h-64 flex-col overflow-y-auto">
						{memberships.data.lists.map((list) => (
							<label
								className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-[14px] hover:bg-[var(--bg-hover)]"
								key={list.id}
							>
								<input
									checked={list.included}
									className="size-4 accent-[var(--accent)]"
									disabled={!accountId || mutation.isPending}
									onChange={() =>
										mutation.mutate({
											accountId: accountId as string,
											listId: list.id,
											handle,
											identifier,
											included: !list.included,
										})
									}
									type="checkbox"
								/>
								<span className="min-w-0 truncate font-medium text-[var(--ink)]">
									{list.name}
								</span>
							</label>
						))}
					</div>
				) : memberships.isPending ? (
					<p className="m-0 px-3 py-2 text-[13px] text-[var(--ink-soft)]">
						正在读取列表…
					</p>
				) : (
					<p className="m-0 px-3 py-2 text-[13px] text-[var(--ink-soft)]">
						还没有列表。
					</p>
				)}
				<a
					className="mt-1 flex min-h-11 items-center rounded-xl px-3 text-[14px] font-semibold text-[var(--accent)] hover:bg-[var(--bg-hover)]"
					href="/lists"
				>
					创建或管理 Lists
				</a>
				{mutation.isError ? (
					<p
						aria-live="polite"
						className="m-0 px-3 py-2 text-[12px] text-[var(--alert)]"
					>
						{mutation.error instanceof Error
							? mutation.error.message
							: "List membership could not be saved"}
					</p>
				) : null}
			</div>
		</details>
	);
}
