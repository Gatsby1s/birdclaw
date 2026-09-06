import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useInfiniteQuery } from "@tanstack/react-query";
import { Plus, Search, Users } from "lucide-react";
import { useState, type FormEvent } from "react";
import {
	ArchiveError,
	useArchiveEvents,
	useArchivePollInterval,
} from "#/components/PersonArchiveShared";
import { useDebouncedValue } from "#/components/useDebouncedValue";
import {
	fetchPeople,
	personAction,
	personArchiveKeys,
} from "#/lib/person-archive-client";
import {
	primaryButtonClass,
	secondaryButtonClass,
	textFieldClass,
} from "#/lib/ui";

export const Route = createFileRoute("/people")({ component: PeopleRoute });

function PeopleRoute() {
	const navigate = useNavigate();
	return (
		<PeopleRouteView
			onCreated={(id) =>
				void navigate({ to: "/people/$personId", params: { personId: id } })
			}
		/>
	);
}

export function PeopleRouteView({
	onCreated,
}: {
	onCreated: (id: string) => void;
}) {
	const [query, setQuery] = useState("");
	const [unreadOnly, setUnreadOnly] = useState(false);
	const [creating, setCreating] = useState(false);
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [kind, setKind] = useState<"x" | "telegram">("x");
	const [url, setUrl] = useState("");
	const search = useDebouncedValue(query, 250);
	const refetchInterval = useArchivePollInterval();
	useArchiveEvents();
	const people = useInfiniteQuery({
		queryKey: [...personArchiveKeys, "list", search, unreadOnly],
		queryFn: ({ pageParam }) => fetchPeople(search, pageParam, unreadOnly),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (page) => page.nextCursor ?? undefined,
		refetchInterval,
	});
	const create = useMutation({
		mutationFn: () =>
			personAction({
				action: "create",
				name: name.trim(),
				description: description.trim(),
				...(url.trim() ? { kind, url: url.trim() } : {}),
			}),
		onSuccess: ({ person }) => onCreated(person.id),
	});
	const entries = [
		...new Map(
			(people.data?.pages.flatMap((page) => page.people) ?? []).map(
				(person) => [person.id, person],
			),
		).values(),
	];
	function submit(event: FormEvent) {
		event.preventDefault();
		if (name.trim()) create.mutate();
	}
	return (
		<section className="min-h-screen">
			<header className="border-b border-[var(--line)] px-5 py-5 sm:px-7">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div>
						<h1 className="m-0 text-2xl font-bold">人物资料库</h1>
						<p className="mt-1 text-sm text-[var(--ink-soft)]">
							把一个人的推文、频道和历史资料，收进同一份档案。
						</p>
					</div>
					<button
						type="button"
						className={primaryButtonClass}
						onClick={() => setCreating(!creating)}
					>
						<Plus size={17} />
						新增人物
					</button>
				</div>
				<div className="mt-5 flex flex-wrap gap-3">
					<label className="flex min-w-48 flex-1 items-center gap-2 rounded-xl border border-[var(--line)] px-3">
						<Search size={18} aria-hidden="true" />
						<input
							className="min-h-11 min-w-0 flex-1 bg-transparent outline-none"
							aria-label="搜索人物"
							placeholder="搜索姓名或账号"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
						/>
					</label>
					<button
						type="button"
						aria-pressed={unreadOnly}
						className={secondaryButtonClass}
						onClick={() => setUnreadOnly(!unreadOnly)}
					>
						{unreadOnly ? "显示全部人物" : "只看未读"}
					</button>
				</div>
			</header>
			{creating && (
				<form
					onSubmit={submit}
					className="grid gap-4 border-b border-[var(--line)] bg-[var(--panel)] p-5 sm:p-7"
				>
					<h2 className="text-lg font-bold">新增人物</h2>
					<label className="grid gap-1 text-sm">
						姓名
						<input
							required
							maxLength={200}
							className={textFieldClass}
							value={name}
							onChange={(event) => setName(event.target.value)}
						/>
					</label>
					<label className="grid gap-1 text-sm">
						简介（可选）
						<textarea
							maxLength={2000}
							className={textFieldClass}
							value={description}
							onChange={(event) => setDescription(event.target.value)}
						/>
					</label>
					<div className="grid gap-3 sm:grid-cols-[140px_1fr]">
						<label className="grid gap-1 text-sm">
							首个来源
							<select
								className={textFieldClass}
								value={kind}
								onChange={(event) =>
									setKind(event.target.value as "x" | "telegram")
								}
							>
								<option value="x">X / Twitter</option>
								<option value="telegram">Telegram</option>
							</select>
						</label>
						<label className="grid gap-1 text-sm">
							账号或频道链接（可稍后添加）
							<input
								className={textFieldClass}
								value={url}
								placeholder={
									kind === "x"
										? "https://x.com/username"
										: "https://t.me/channel"
								}
								onChange={(event) => setUrl(event.target.value)}
							/>
						</label>
					</div>
					<p className="text-xs leading-relaxed text-[var(--ink-soft)]">
						添加来源后自动开始收集可访问的历史内容，并持续同步新增内容。历史覆盖和媒体保存进度会分别显示。
					</p>
					<ArchiveError error={create.error} />
					<div className="flex gap-2">
						<button
							className={primaryButtonClass}
							disabled={create.isPending || !name.trim()}
						>
							{create.isPending ? "创建中…" : "创建档案"}
						</button>
						<button
							type="button"
							className={secondaryButtonClass}
							onClick={() => setCreating(false)}
						>
							收起
						</button>
					</div>
				</form>
			)}
			<div className="p-5 sm:p-7">
				<ArchiveError error={people.error} />
				{people.data && (
					<p className="mb-4 text-xs text-[var(--ink-soft)]">
						共 {people.data.pages[0].total} 位{unreadOnly ? "有未读更新的" : ""}
						人物 · 已显示 {entries.length} 位
					</p>
				)}
				{people.isPending ? (
					<p role="status" className="py-10 text-center text-[var(--ink-soft)]">
						正在读取人物资料…
					</p>
				) : entries.length === 0 ? (
					<div className="py-16 text-center text-[var(--ink-soft)]">
						<Users className="mx-auto mb-3" size={32} />
						<p>
							{unreadOnly
								? "暂时没有未读更新"
								: query
									? "没有匹配的人物"
									: "从第一位人物开始"}
						</p>
						<p className="mt-2 text-sm">
							可以只填姓名，之后再添加账号、频道或上传资料。
						</p>
					</div>
				) : (
					<div className="grid gap-3 sm:grid-cols-2">
						{entries.map((person) => (
							<Link
								key={person.id}
								to="/people/$personId"
								params={{ personId: person.id }}
								className="block min-w-0 rounded-2xl border border-[var(--line)] p-5 transition-colors hover:bg-[var(--bg-hover)]"
							>
								<div className="flex items-start justify-between gap-3">
									<h2 className="truncate text-lg font-bold">{person.name}</h2>
									{person.unreadCount > 0 && (
										<span className="shrink-0 rounded-full bg-[var(--accent)] px-2 py-0.5 text-xs font-bold text-white">
											{person.unreadCount} 未读
										</span>
									)}
								</div>
								<p className="mt-2 line-clamp-2 min-h-10 text-sm text-[var(--ink-soft)]">
									{person.description || "尚未添加简介"}
								</p>
								<div className="mt-4 flex flex-wrap gap-2 text-xs text-[var(--ink-soft)]">
									<span>{person.itemCount.toLocaleString()} 条内容</span>
									{person.sources.map((source) => (
										<span
											key={source.id}
											className="rounded border border-[var(--line)] px-1.5"
										>
											{source.kind === "x" ? "X" : "Telegram"}
										</span>
									))}
								</div>
							</Link>
						))}
					</div>
				)}
				{people.hasNextPage && (
					<div className="mt-5 text-center">
						<button
							type="button"
							className={secondaryButtonClass}
							disabled={people.isFetchingNextPage}
							onClick={() => void people.fetchNextPage()}
						>
							{people.isFetchingNextPage ? "读取中…" : "加载更多人物"}
						</button>
					</div>
				)}
			</div>
		</section>
	);
}
