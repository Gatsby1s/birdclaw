import { useEffect, useState } from "react";
import {
	useMutation,
	useInfiniteQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
	personAction,
	fetchPeople,
	personArchiveKeys,
} from "#/lib/person-archive-client";
import type { PersonSummary } from "#/lib/person-archive-types";
import {
	primaryButtonClass,
	secondaryButtonClass,
	textFieldClass,
} from "#/lib/ui";
import { useDebouncedValue } from "./useDebouncedValue";

export function useArchivePollInterval() {
	const [visible, setVisible] = useState(true);
	useEffect(() => {
		const update = () => setVisible(document.visibilityState !== "hidden");
		update();
		document.addEventListener("visibilitychange", update);
		return () => document.removeEventListener("visibilitychange", update);
	}, []);
	return visible ? 30_000 : false;
}

export function useArchiveEvents(personId?: string) {
	const client = useQueryClient();
	useEffect(() => {
		if (typeof EventSource === "undefined") return;
		let stream: EventSource | null = null;
		let latestSequence: number | undefined;
		function connect() {
			stream?.close();
			stream = null;
			if (document.visibilityState === "hidden") return;
			const search = new URLSearchParams();
			if (personId) search.set("personId", personId);
			if (latestSequence !== undefined)
				search.set("after", String(latestSequence));
			stream = new EventSource(`/api/person-events?${search}`);
			stream.addEventListener("archive-updated", (event) => {
				try {
					const update = JSON.parse((event as MessageEvent<string>).data) as {
						personId?: unknown;
						latestSequence?: unknown;
					};
					if (
						typeof update.latestSequence !== "number" ||
						!Number.isSafeInteger(update.latestSequence) ||
						update.latestSequence < 0
					)
						return;
					if (
						personId &&
						update.personId !== null &&
						update.personId !== personId
					)
						return;
					latestSequence = Math.max(latestSequence ?? 0, update.latestSequence);
					void client.invalidateQueries({
						queryKey: personId
							? [...personArchiveKeys, "detail", personId]
							: [...personArchiveKeys, "list"],
					});
				} catch {
					// Malformed events leave the periodic refresh fallback in charge.
				}
			});
			// EventSource reconnects automatically; periodic polling also stays active.
			stream.onerror = () => {};
		}
		connect();
		document.addEventListener("visibilitychange", connect);
		return () => {
			document.removeEventListener("visibilitychange", connect);
			stream?.close();
		};
	}, [client, personId]);
}

export function ArchiveError({ error }: { error: unknown }) {
	if (!error) return null;
	return (
		<p
			role="alert"
			className="rounded-xl border border-[var(--alert)] bg-[var(--alert-soft)] p-3 text-sm text-[var(--alert)]"
		>
			{error instanceof Error ? error.message : "操作未完成，请重试。"}
		</p>
	);
}

export function ProfilePersonArchiveButton({ handle }: { handle: string }) {
	const navigate = useNavigate();
	const mutation = useMutation({
		mutationFn: () => personAction({ action: "resolve", handle }),
		onSuccess: ({ person }) =>
			void navigate({
				to: "/people/$personId",
				params: { personId: person.id },
			}),
	});
	return (
		<div>
			<button
				type="button"
				className={secondaryButtonClass}
				disabled={mutation.isPending || !handle}
				onClick={() => mutation.mutate()}
			>
				{mutation.isPending ? "正在打开…" : "人物资料"}
			</button>
			<ArchiveError error={mutation.error} />
		</div>
	);
}

export function PersonArchiveMerge({ person }: { person: PersonSummary }) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [selected, setSelected] = useState<PersonSummary | null>(null);
	const search = useDebouncedValue(query, 250);
	const navigate = useNavigate();
	const client = useQueryClient();
	const candidates = useInfiniteQuery({
		queryKey: [...personArchiveKeys, "merge-candidates", search],
		queryFn: ({ pageParam }) => fetchPeople(search, pageParam),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (page) => page.nextCursor ?? undefined,
		enabled: open,
	});
	const merge = useMutation({
		mutationFn: () => {
			if (!selected) throw new Error("请先选择保留的人物档案。");
			return personAction({
				action: "merge",
				personId: person.id,
				targetPersonId: selected.id,
			});
		},
		onSuccess: ({ person: survivor }) => {
			void client.invalidateQueries({ queryKey: personArchiveKeys });
			setOpen(false);
			setSelected(null);
			void navigate({
				to: "/people/$personId",
				params: { personId: survivor.id },
				replace: true,
			});
		},
	});
	const entries = [
		...new Map(
			(candidates.data?.pages.flatMap((page) => page.people) ?? [])
				.filter((entry) => entry.id !== person.id)
				.map((entry) => [entry.id, entry]),
		).values(),
	];
	return (
		<div className="border-t border-[var(--line)] pt-4">
			<button
				type="button"
				className="text-sm font-semibold text-[var(--ink-soft)]"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
			>
				合并到另一人物
			</button>
			{open && (
				<div className="mt-3 grid gap-3">
					<p className="text-xs leading-relaxed text-[var(--ink-soft)]">
						同一个人的账号分散在不同档案时，可以合并。当前档案的来源、内容、媒体和未读记录将移到选中的档案，保留资料与历史记录。
					</p>
					<label className="grid gap-1 text-sm">
						搜索要保留的人物档案
						<input
							className={textFieldClass}
							value={query}
							onChange={(event) => {
								setQuery(event.target.value);
								setSelected(null);
							}}
							placeholder="输入姓名或账号"
						/>
					</label>
					<ArchiveError error={candidates.error} />
					{candidates.isPending ? (
						<p role="status" className="text-sm text-[var(--ink-soft)]">
							正在读取人物…
						</p>
					) : (
						<div className="max-h-60 overflow-y-auto rounded-xl border border-[var(--line)]">
							{entries.map((entry) => (
								<button
									type="button"
									key={entry.id}
									disabled={merge.isPending}
									aria-label={`选择保留人物：${entry.name}`}
									aria-pressed={selected?.id === entry.id}
									className="block w-full border-b border-[var(--line)] px-3 py-3 text-left text-sm hover:bg-[var(--bg-hover)] aria-pressed:bg-[var(--accent-soft)]"
									onClick={() => setSelected(entry)}
								>
									<strong>{entry.name}</strong>
									<span className="ml-2 text-xs text-[var(--ink-soft)]">
										{entry.itemCount} 条内容 ·{" "}
										{entry.sources
											.map((source) => source.identifier)
											.join(" · ") || "未关联来源"}
									</span>
								</button>
							))}
							{!entries.length && (
								<p className="p-3 text-sm text-[var(--ink-soft)]">
									没有找到其他人物档案。
								</p>
							)}
							{candidates.hasNextPage && (
								<button
									type="button"
									className="w-full p-3 text-sm text-[var(--accent)]"
									disabled={candidates.isFetchingNextPage}
									onClick={() => void candidates.fetchNextPage()}
								>
									加载更多候选人物
								</button>
							)}
						</div>
					)}
					{selected && (
						<div className="rounded-xl border border-[var(--line-strong)] p-3">
							<p className="mb-3 text-sm">
								将「{person.name}」合并到「{selected.name}」，以后统一使用「
								{selected.name}」的人物档案。
							</p>
							<button
								type="button"
								className={primaryButtonClass}
								disabled={merge.isPending}
								onClick={() => merge.mutate()}
							>
								{merge.isPending ? "合并中…" : `确认合并到「${selected.name}」`}
							</button>
						</div>
					)}
					<ArchiveError error={merge.error} />
				</div>
			)}
		</div>
	);
}
