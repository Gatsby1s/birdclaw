import { createFileRoute } from "@tanstack/react-router";
import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import {
	ArrowLeft,
	List as ListIcon,
	Loader2,
	Pencil,
	Plus,
	Trash2,
	UserMinus,
	UserPlus,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { AvatarChip } from "#/components/AvatarChip";
import { FeedEmpty, FeedError, FeedLoading } from "#/components/FeedState";
import { SyncNowButton } from "#/components/SyncNowButton";
import { TimelineCard } from "#/components/TimelineCard";
import { useSelectedAccountId } from "#/components/account-selection";
import { useDebouncedValue } from "#/components/useDebouncedValue";
import { fetchJson, fetchQueryEnvelope, postAction } from "#/lib/api-client";
import {
	profileListCollectionSchema,
	profileListFeedResponseSchema,
	profileListMembersResponseSchema,
	profileListSummarySchema,
} from "#/lib/api-contracts";
import { queryKeys } from "#/lib/query-client";
import type { ProfileListSummary, TimelineItem } from "#/lib/types";
import {
	cx,
	pageHeaderClass,
	pageHeaderRowClass,
	pageSubtitleClass,
	pageTitleClass,
	primaryButtonClass,
	secondaryButtonClass,
	tabButtonActiveClass,
	tabButtonClass,
	tabButtonIndicatorClass,
	tabStripClass,
} from "#/lib/ui";

interface ListsRouteSearch {
	list: string;
	tab: "posts" | "members";
}

function validateListsSearch(
	search: Record<string, unknown>,
): ListsRouteSearch {
	return {
		list: typeof search.list === "string" ? search.list.slice(0, 128) : "",
		tab: search.tab === "members" ? "members" : "posts",
	};
}

export const Route = createFileRoute("/lists")({
	component: ListsRoute,
	validateSearch: validateListsSearch,
});

function ListsRoute() {
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<ListsRouteView
			onSearchChange={(next, replace = false) =>
				void navigate({ search: next, replace })
			}
			searchState={search}
		/>
	);
}

async function listRequest(
	method: "POST" | "PATCH",
	body: Record<string, unknown>,
) {
	return fetchJson(
		"/api/lists",
		{
			method,
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
		profileListSummarySchema,
		"List could not be saved",
	);
}

async function deleteListRequest(accountId: string, listId: string) {
	const response = await fetch("/api/lists", {
		method: "DELETE",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ accountId, listId }),
	});
	if (!response.ok) throw new Error("List could not be deleted");
}

async function membershipRequest(input: {
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

const fieldClass =
	"min-h-11 w-full rounded-xl border border-[var(--line-strong)] bg-[var(--bg)] px-3 text-[14px] text-[var(--ink)] outline-none focus:border-[var(--accent)]";

function ListIndex({
	lists,
	accountId,
	onSelect,
	onCreated,
}: {
	lists: ProfileListSummary[];
	accountId: string;
	onSelect: (listId: string) => void;
	onCreated: (list: ProfileListSummary) => void;
}) {
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const createMutation = useMutation({
		mutationFn: () => listRequest("POST", { accountId, name, description }),
		onSuccess: (list) => {
			setName("");
			setDescription("");
			onCreated(list);
		},
	});

	function submit(event: FormEvent) {
		event.preventDefault();
		if (name.trim()) createMutation.mutate();
	}

	return (
		<div className="grid gap-5 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.65fr)]">
			<div className="flex min-w-0 flex-col gap-3">
				{lists.length ? (
					lists.map((list) => (
						<button
							className="flex min-h-20 w-full items-center gap-4 rounded-2xl border border-[var(--line)] bg-[var(--panel)] px-4 py-3 text-left transition hover:border-[var(--line-strong)] hover:bg-[var(--bg-hover)]"
							key={list.id}
							onClick={() => onSelect(list.id)}
							type="button"
						>
							<span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-[var(--bg-active)] text-[var(--accent)]">
								<ListIcon aria-hidden="true" className="size-6" />
							</span>
							<span className="min-w-0 flex-1">
								<strong className="block truncate text-[16px] text-[var(--ink)]">
									{list.name}
								</strong>
								<span className="mt-0.5 block truncate text-[13px] text-[var(--ink-soft)]">
									{list.description || "私有账号列表"}
								</span>
								<span className="mt-1 block text-[12px] text-[var(--ink-soft)]">
									{String(list.memberCount)} 位成员
								</span>
							</span>
						</button>
					))
				) : (
					<FeedEmpty
						detail="创建一个列表，再从作者资料页或成员搜索中加入账号。"
						label="还没有 Lists"
					/>
				)}
			</div>
			<form
				className="h-fit rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-4"
				onSubmit={submit}
			>
				<h2 className="m-0 text-[17px] font-bold text-[var(--ink)]">
					创建 List
				</h2>
				<p className="mb-4 mt-1 text-[13px] text-[var(--ink-soft)]">
					把重要账号分组，只看这组人的动态。
				</p>
				<label className="flex flex-col gap-1.5 text-[13px] font-semibold text-[var(--ink)]">
					名称
					<input
						className={fieldClass}
						maxLength={25}
						onChange={(event) => setName(event.currentTarget.value)}
						placeholder="例如：美股事实源"
						value={name}
					/>
				</label>
				<label className="mt-3 flex flex-col gap-1.5 text-[13px] font-semibold text-[var(--ink)]">
					说明（可选）
					<input
						className={fieldClass}
						maxLength={100}
						onChange={(event) => setDescription(event.currentTarget.value)}
						placeholder="这个列表收什么"
						value={description}
					/>
				</label>
				<button
					className={cx(primaryButtonClass, "mt-4 min-h-11 w-full")}
					disabled={!name.trim() || createMutation.isPending}
					type="submit"
				>
					{createMutation.isPending ? (
						<Loader2 className="size-4 animate-spin" />
					) : (
						<Plus className="size-4" />
					)}
					创建
				</button>
				{createMutation.isError ? (
					<p className="mb-0 mt-3 text-[12px] text-[var(--alert)]">
						{createMutation.error instanceof Error
							? createMutation.error.message
							: "List could not be created"}
					</p>
				) : null}
			</form>
		</div>
	);
}

function ListMembers({
	accountId,
	list,
}: {
	accountId: string;
	list: ProfileListSummary;
}) {
	const queryClient = useQueryClient();
	const [search, setSearch] = useState("");
	const debouncedSearch = useDebouncedValue(search, 180);
	const queryKey = [
		...queryKeys.profileListMembers,
		accountId,
		list.id,
		debouncedSearch,
	] as const;
	const query = useQuery({
		queryKey,
		queryFn: ({ signal }) => {
			const url = new URL("/api/list-members", window.location.origin);
			url.searchParams.set("account", accountId);
			url.searchParams.set("listId", list.id);
			if (debouncedSearch) url.searchParams.set("search", debouncedSearch);
			return fetchJson(
				url,
				{ signal },
				profileListMembersResponseSchema,
				"List members unavailable",
			);
		},
	});
	const mutation = useMutation({
		mutationFn: membershipRequest,
		onSuccess: async () => {
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: queryKeys.profileListMembers,
				}),
				queryClient.invalidateQueries({ queryKey: queryKeys.profileLists }),
				queryClient.invalidateQueries({ queryKey: queryKeys.profileListFeed }),
			]);
		},
	});

	return (
		<div className="flex min-w-0 flex-col gap-4 p-4">
			<input
				aria-label="Search profiles to add"
				className={fieldClass}
				onChange={(event) => setSearch(event.currentTarget.value)}
				placeholder="搜索姓名或 @handle 添加成员"
				value={search}
			/>
			{query.isPending ? (
				<FeedLoading detail="正在读取本地账号资料" label="加载成员" />
			) : query.isError ? (
				<FeedError
					action={
						<button
							className={secondaryButtonClass}
							onClick={() => void query.refetch()}
							type="button"
						>
							重试
						</button>
					}
					message={
						query.error instanceof Error
							? query.error.message
							: "List members unavailable"
					}
					title="成员加载失败"
				/>
			) : (
				<>
					{debouncedSearch ? (
						<div className="rounded-2xl border border-[var(--line)] bg-[var(--panel)]">
							<h2 className="m-0 border-b border-[var(--line)] px-4 py-3 text-[15px] font-bold">
								搜索结果
							</h2>
							{query.data?.candidates.length ? (
								query.data.candidates.map(({ profile, included }) => (
									<div
										className="flex min-h-16 items-center gap-3 border-b border-[var(--line)] px-4 py-2 last:border-b-0"
										key={profile.id}
									>
										<AvatarChip
											avatarUrl={profile.avatarUrl}
											hue={profile.avatarHue}
											name={profile.displayName}
											profileId={profile.id}
										/>
										<span className="min-w-0 flex-1">
											<strong className="block truncate text-[14px]">
												{profile.displayName}
											</strong>
											<span className="block truncate text-[13px] text-[var(--ink-soft)]">
												@{profile.handle}
											</span>
										</span>
										<button
											className={cx(secondaryButtonClass, "min-h-11")}
											disabled={mutation.isPending}
											onClick={() =>
												mutation.mutate({
													accountId,
													listId: list.id,
													handle: profile.handle,
													identifier: profile.id,
													included: !included,
												})
											}
											type="button"
										>
											{included ? (
												<UserMinus className="size-4" />
											) : (
												<UserPlus className="size-4" />
											)}
											{included ? "移除" : "加入"}
										</button>
									</div>
								))
							) : (
								<p className="m-0 px-4 py-5 text-[13px] text-[var(--ink-soft)]">
									没有匹配的本地账号。
								</p>
							)}
						</div>
					) : null}
					<div className="rounded-2xl border border-[var(--line)] bg-[var(--panel)]">
						<h2 className="m-0 border-b border-[var(--line)] px-4 py-3 text-[15px] font-bold">
							成员 · {String(query.data?.members.length ?? 0)}
						</h2>
						{query.data?.members.length ? (
							query.data.members.map((entry) => (
								<div
									className="flex min-h-16 items-center gap-3 border-b border-[var(--line)] px-4 py-2 last:border-b-0"
									key={entry.memberKey}
								>
									<AvatarChip
										avatarUrl={entry.profile?.avatarUrl}
										hue={entry.profile?.avatarHue ?? 210}
										name={entry.profile?.displayName ?? entry.handle}
										profileId={entry.profile?.id}
									/>
									<span className="min-w-0 flex-1">
										<strong className="block truncate text-[14px]">
											{entry.profile?.displayName ?? `@${entry.handle}`}
										</strong>
										<span className="block truncate text-[13px] text-[var(--ink-soft)]">
											@{entry.handle}
										</span>
									</span>
									<button
										aria-label={`Remove @${entry.handle}`}
										className={cx(secondaryButtonClass, "min-h-11")}
										disabled={mutation.isPending}
										onClick={() =>
											mutation.mutate({
												accountId,
												listId: list.id,
												handle: entry.handle,
												identifier: entry.identifier,
												included: false,
											})
										}
										type="button"
									>
										<UserMinus className="size-4" /> 移除
									</button>
								</div>
							))
						) : (
							<p className="m-0 px-4 py-5 text-[13px] text-[var(--ink-soft)]">
								这个 List 还没有成员。
							</p>
						)}
					</div>
				</>
			)}
		</div>
	);
}

function ListPosts({
	accountId,
	list,
}: {
	accountId: string;
	list: ProfileListSummary;
}) {
	const queryClient = useQueryClient();
	const [search, setSearch] = useState("");
	const debouncedSearch = useDebouncedValue(search, 180);
	const query = useInfiniteQuery({
		queryKey: [
			...queryKeys.profileListFeed,
			accountId,
			list.id,
			debouncedSearch,
		],
		initialPageParam: undefined as
			| { until: string; untilId: string }
			| undefined,
		queryFn: ({ pageParam, signal }) => {
			const url = new URL("/api/list-feed", window.location.origin);
			url.searchParams.set("account", accountId);
			url.searchParams.set("listId", list.id);
			url.searchParams.set("limit", "40");
			if (debouncedSearch) url.searchParams.set("search", debouncedSearch);
			if (pageParam) {
				url.searchParams.set("until", pageParam.until);
				url.searchParams.set("untilId", pageParam.untilId);
			}
			return fetchJson(
				url,
				{ signal },
				profileListFeedResponseSchema,
				"List timeline unavailable",
			);
		},
		getNextPageParam: (lastPage) => {
			const last = lastPage.items.at(-1);
			return lastPage.hasMore && last
				? { until: last.createdAt, untilId: last.id }
				: undefined;
		},
	});
	const items = useMemo(() => {
		const seen = new Set<string>();
		const merged: TimelineItem[] = [];
		for (const page of query.data?.pages ?? []) {
			for (const item of page.items) {
				if (seen.has(item.id)) continue;
				seen.add(item.id);
				merged.push(item);
			}
		}
		return merged;
	}, [query.data]);
	const replyMutation = useMutation({
		mutationFn: ({ tweetId, text }: { tweetId: string; text: string }) =>
			postAction({ kind: "replyTweet", accountId, tweetId, text }),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: queryKeys.profileListFeed }),
	});
	async function replyToTweet(tweetId: string) {
		const text = window.prompt("Reply text");
		if (!text?.trim()) return;
		await replyMutation
			.mutateAsync({ tweetId, text: text.trim() })
			.catch(() => {});
	}

	return (
		<div className="min-w-0">
			<div className="flex flex-wrap items-center gap-2 border-b border-[var(--line)] p-3">
				<input
					aria-label="Search this List"
					className={cx(fieldClass, "min-w-[220px] flex-1")}
					onChange={(event) => setSearch(event.currentTarget.value)}
					placeholder="搜索这个 List 的推文"
					value={search}
				/>
				<SyncNowButton
					kind="timeline"
					label="刷新 Home"
					onSynced={() => {
						void queryClient.invalidateQueries({
							queryKey: queryKeys.profileListFeed,
						});
					}}
					showAccountPicker={false}
				/>
			</div>
			<p className="m-0 border-b border-[var(--line)] px-4 py-2 text-[12px] text-[var(--ink-soft)]">
				显示 BirdClaw 已同步的成员推文；刷新 Home 后会更新。
			</p>
			{query.isPending ? (
				<FeedLoading detail="正在筛选成员动态" label="加载 List" />
			) : query.isError ? (
				<FeedError
					action={
						<button
							className={secondaryButtonClass}
							onClick={() => void query.refetch()}
							type="button"
						>
							重试
						</button>
					}
					message={
						query.error instanceof Error
							? query.error.message
							: "List timeline unavailable"
					}
					title="List 时间线加载失败"
				/>
			) : items.length ? (
				<>
					{items.map((item) => (
						<TimelineCard item={item} key={item.id} onReply={replyToTweet} />
					))}
					{replyMutation.isError ? (
						<p
							aria-live="polite"
							className="m-0 border-t border-[var(--line)] px-4 py-3 text-[13px] text-[var(--alert)]"
						>
							{replyMutation.error instanceof Error
								? replyMutation.error.message
								: "Reply failed"}
						</p>
					) : null}
					{query.hasNextPage ? (
						<button
							className="min-h-12 w-full border-t border-[var(--line)] text-[14px] font-semibold text-[var(--accent)] hover:bg-[var(--bg-hover)]"
							disabled={query.isFetchingNextPage}
							onClick={() => void query.fetchNextPage()}
							type="button"
						>
							{query.isFetchingNextPage ? "加载中…" : "加载更多"}
						</button>
					) : null}
				</>
			) : (
				<FeedEmpty
					detail={
						list.memberCount
							? "刷新 Home，或确认这些账号已有本地推文。"
							: "先在成员页加入账号。"
					}
					label={
						list.memberCount ? "暂时没有已同步推文" : "这个 List 还没有成员"
					}
				/>
			)}
		</div>
	);
}

function SelectedList({
	accountId,
	list,
	tab,
	onBack,
	onTab,
	onDeleted,
	onUpdated,
}: {
	accountId: string;
	list: ProfileListSummary;
	tab: "posts" | "members";
	onBack: () => void;
	onTab: (tab: "posts" | "members") => void;
	onDeleted: () => void;
	onUpdated: () => void;
}) {
	const [editing, setEditing] = useState(false);
	const [name, setName] = useState(list.name);
	const [description, setDescription] = useState(list.description);
	const updateMutation = useMutation({
		mutationFn: () =>
			listRequest("PATCH", { accountId, listId: list.id, name, description }),
		onSuccess: () => {
			setEditing(false);
			onUpdated();
		},
	});
	const deleteMutation = useMutation({
		mutationFn: () => deleteListRequest(accountId, list.id),
		onSuccess: onDeleted,
	});
	return (
		<>
			<header className={pageHeaderClass}>
				<div className={pageHeaderRowClass}>
					<button
						aria-label="Back to Lists"
						className={cx(secondaryButtonClass, "min-h-11")}
						onClick={onBack}
						type="button"
					>
						<ArrowLeft className="size-4" />
					</button>
					<div className="min-w-0 flex-1">
						<h1 className={pageTitleClass}>{list.name}</h1>
						<p className={pageSubtitleClass}>
							{list.description || "私有账号列表"} · {String(list.memberCount)}{" "}
							位成员
						</p>
					</div>
					<button
						className={cx(secondaryButtonClass, "min-h-11")}
						onClick={() => setEditing((value) => !value)}
						type="button"
					>
						<Pencil className="size-4" /> 管理
					</button>
				</div>
				{editing ? (
					<form
						className="grid gap-2 px-4 pb-4 sm:grid-cols-[1fr_1.5fr_auto_auto]"
						onSubmit={(event) => {
							event.preventDefault();
							updateMutation.mutate();
						}}
					>
						<input
							aria-label="List name"
							className={fieldClass}
							maxLength={25}
							onChange={(event) => setName(event.currentTarget.value)}
							value={name}
						/>
						<input
							aria-label="List description"
							className={fieldClass}
							maxLength={100}
							onChange={(event) => setDescription(event.currentTarget.value)}
							value={description}
						/>
						<button
							className={cx(primaryButtonClass, "min-h-11")}
							disabled={!name.trim() || updateMutation.isPending}
							type="submit"
						>
							保存
						</button>
						<button
							className={cx(
								secondaryButtonClass,
								"min-h-11 text-[var(--alert)]",
							)}
							disabled={deleteMutation.isPending}
							onClick={() => {
								if (window.confirm(`删除 List“${list.name}”？`))
									deleteMutation.mutate();
							}}
							type="button"
						>
							<Trash2 className="size-4" /> 删除
						</button>
					</form>
				) : null}
				<div className={tabStripClass}>
					{(["posts", "members"] as const).map((value) => {
						const active = tab === value;
						return (
							<button
								aria-pressed={active}
								className={cx(tabButtonClass, active && tabButtonActiveClass)}
								key={value}
								onClick={() => onTab(value)}
								type="button"
							>
								<span className="relative inline-flex flex-col items-center justify-center py-1">
									{value === "posts" ? "Posts" : "Members"}
									{active ? <span className={tabButtonIndicatorClass} /> : null}
								</span>
							</button>
						);
					})}
				</div>
			</header>
			{tab === "members" ? (
				<ListMembers accountId={accountId} list={list} />
			) : (
				<ListPosts accountId={accountId} list={list} />
			)}
		</>
	);
}

export function ListsRouteView({
	searchState,
	onSearchChange,
}: {
	searchState?: ListsRouteSearch;
	onSearchChange?: (next: ListsRouteSearch, replace?: boolean) => void;
} = {}) {
	const queryClient = useQueryClient();
	const [localSearch, setLocalSearch] = useState<ListsRouteSearch>(() =>
		validateListsSearch({}),
	);
	const search = searchState ?? localSearch;
	const updateSearch = (next: ListsRouteSearch, replace = false) =>
		onSearchChange ? onSearchChange(next, replace) : setLocalSearch(next);
	const statusQuery = useQuery({
		queryKey: queryKeys.status,
		queryFn: ({ signal }) => fetchQueryEnvelope({ signal }),
	});
	const accountId = useSelectedAccountId(statusQuery.data?.accounts);
	const listsQuery = useQuery({
		queryKey: [...queryKeys.profileLists, accountId ?? "none"],
		queryFn: ({ signal }) => {
			const url = new URL("/api/lists", window.location.origin);
			url.searchParams.set("account", accountId as string);
			return fetchJson(
				url,
				{ signal },
				profileListCollectionSchema,
				"Lists unavailable",
			);
		},
		enabled: Boolean(accountId),
	});
	const selected = listsQuery.data?.lists.find(
		(list) => list.id === search.list,
	);
	useEffect(() => {
		if (!listsQuery.isSuccess || !search.list || selected) return;
		updateSearch({ list: "", tab: "posts" }, true);
	}, [listsQuery.isSuccess, search.list, selected]);
	async function refreshLists() {
		await queryClient.invalidateQueries({ queryKey: queryKeys.profileLists });
	}
	if (statusQuery.isPending || (accountId && listsQuery.isPending))
		return <FeedLoading detail="正在读取云端私有列表" label="加载 Lists" />;
	if (statusQuery.isError || listsQuery.isError || !accountId)
		return (
			<FeedError
				action={
					<button
						className={secondaryButtonClass}
						onClick={() => {
							void Promise.all([statusQuery.refetch(), listsQuery.refetch()]);
						}}
						type="button"
					>
						重试
					</button>
				}
				message={
					statusQuery.error instanceof Error
						? statusQuery.error.message
						: listsQuery.error instanceof Error
							? listsQuery.error.message
							: "没有可用账号"
				}
				title="Lists 暂时不可用"
			/>
		);
	return (
		<section className="flex min-h-screen min-w-0 flex-col">
			{selected ? (
				<SelectedList
					accountId={accountId}
					list={selected}
					tab={search.tab}
					onBack={() => updateSearch({ list: "", tab: "posts" })}
					onDeleted={() => {
						void refreshLists();
						updateSearch({ list: "", tab: "posts" });
					}}
					onTab={(tab) => updateSearch({ ...search, tab }, true)}
					onUpdated={() => void refreshLists()}
				/>
			) : (
				<>
					<header className={pageHeaderClass}>
						<div className={pageHeaderRowClass}>
							<div>
								<h1 className={pageTitleClass}>Lists</h1>
								<p className={pageSubtitleClass}>
									像 X 一样，把账号分组后单独阅读。
								</p>
							</div>
						</div>
					</header>
					<ListIndex
						accountId={accountId}
						lists={listsQuery.data?.lists ?? []}
						onCreated={(list) => {
							void refreshLists();
							updateSearch({ list: list.id, tab: "members" });
						}}
						onSelect={(listId) => updateSearch({ list: listId, tab: "posts" })}
					/>
				</>
			)}
		</section>
	);
}
