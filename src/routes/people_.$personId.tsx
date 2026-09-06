import { createFileRoute, Link } from "@tanstack/react-router";
import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { ArrowLeft, Bell, Check, Plus, Upload } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import {
	ArchiveError,
	PersonArchiveMerge,
	useArchiveEvents,
	useArchivePollInterval,
} from "#/components/PersonArchiveShared";
import {
	PersonArchiveItem,
	safeArchiveUrl,
} from "#/components/PersonArchiveItem";
import { useDebouncedValue } from "#/components/useDebouncedValue";
import {
	fetchPerson,
	fetchPersonItems,
	personAction,
	personArchiveKeys,
	uploadPersonFile,
	type PersonAction,
} from "#/lib/person-archive-client";
import type { PersonDetail, PersonSource } from "#/lib/person-archive-types";
import {
	primaryButtonClass,
	secondaryButtonClass,
	textFieldClass,
} from "#/lib/ui";

export const Route = createFileRoute("/people_/$personId")({
	component: PersonRoute,
	validateSearch: (search: Record<string, unknown>): { document?: string } =>
		typeof search.document === "string" &&
		/^[a-zA-Z0-9-]{1,128}$/.test(search.document)
			? { document: search.document }
			: {},
});
function PersonRoute() {
	const { personId } = Route.useParams();
	const { document } = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<PersonRouteView
			personId={personId}
			documentId={document}
			onClearDocument={() => void navigate({ search: {}, replace: true })}
		/>
	);
}

const historyLabels: Record<string, string> = {
	queued: "等待历史采集",
	public_caught_up: "已读完公开网页可见历史",
	existing_archive: "已有归档，尚未申请全历史",
	backfilling: "正在补齐历史",
	public_history_exhausted: "公开可见历史已遍历",
	caught_up_unverified: "已追至最新，完整性待核验",
	verified_complete: "历史完整性已核验",
	needs_attention: "需要处理",
	failed: "采集失败",
	pending: "等待采集",
	paused: "已暂停",
};

function SourceRow({
	source,
	run,
	pending,
}: {
	source: PersonSource;
	run: (action: PersonAction) => void;
	pending: boolean;
}) {
	const url = safeArchiveUrl(source.url);
	return (
		<div className="rounded-xl border border-[var(--line)] p-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<strong className="min-w-0 break-all text-sm">
					{source.kind === "x" ? "X" : "Telegram"} · {source.identifier}
				</strong>
				<span className="text-xs text-[var(--ink-soft)]">
					{source.enabled ? "持续同步" : "已暂停"}
				</span>
			</div>
			<p className="mt-2 text-xs">
				{historyLabels[source.historyStatus] ?? "正在核对采集状态"}
			</p>
			<p className="mt-1 text-xs leading-relaxed text-[var(--ink-soft)]">
				{source.itemCount.toLocaleString()} 条内容 · 媒体已保存{" "}
				{source.mediaStoredCount}，待处理 {source.mediaPendingCount}，失败{" "}
				{source.mediaFailedCount}
			</p>
			{source.coverage === "public_web" && (
				<p className="mt-1 text-xs text-[var(--ink-soft)]">
					覆盖公开网页可访问内容；不代表已取得私密、删除或受限历史。
				</p>
			)}
			<p className="mt-1 text-xs text-[var(--ink-soft)]">
				最近同步：
				{source.lastSyncedAt
					? new Date(source.lastSyncedAt).toLocaleString("zh-CN")
					: "尚未同步"}
			</p>
			{source.lastError && (
				<p className="mt-2 break-words text-xs text-[var(--alert)]">
					{source.lastError}
				</p>
			)}
			<div className="mt-3 flex flex-wrap gap-3 text-xs">
				<button
					type="button"
					disabled={pending}
					className="font-semibold text-[var(--accent)] disabled:opacity-50"
					onClick={() =>
						run({
							action: "sourceState",
							sourceId: source.id,
							enabled: !source.enabled,
						})
					}
				>
					{source.enabled ? "暂停同步" : "恢复同步"}
				</button>
				<button
					type="button"
					disabled={pending || !source.enabled}
					className="font-semibold text-[var(--accent)] disabled:opacity-50"
					onClick={() => run({ action: "retry", sourceId: source.id })}
				>
					重试采集
				</button>
				{url && (
					<a
						href={url}
						target="_blank"
						rel="noreferrer"
						className="text-[var(--ink-soft)]"
					>
						打开来源
					</a>
				)}
			</div>
		</div>
	);
}

function PersonSettings({
	person,
	onSaved,
}: {
	person: PersonDetail;
	onSaved: () => void;
}) {
	const [name, setName] = useState(person.name);
	const [description, setDescription] = useState(person.description);
	const [url, setUrl] = useState("");
	const [kind, setKind] = useState<"x" | "telegram">("telegram");
	const mutation = useMutation({
		mutationFn: personAction,
		onSuccess: (_, action) => {
			if (action.action === "addSource") setUrl("");
			onSaved();
		},
	});
	return (
		<div className="grid gap-5 border-b border-[var(--line)] bg-[var(--panel)] p-5 sm:p-7">
			<details>
				<summary className="cursor-pointer text-sm font-semibold">
					编辑姓名与简介
				</summary>
				<form
					className="mt-3 grid gap-3"
					onSubmit={(event) => {
						event.preventDefault();
						mutation.mutate({
							action: "update",
							personId: person.id,
							name: name.trim(),
							description: description.trim(),
						});
					}}
				>
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
						简介
						<textarea
							maxLength={2000}
							className={textFieldClass}
							value={description}
							onChange={(event) => setDescription(event.target.value)}
						/>
					</label>
					<button
						className={`${primaryButtonClass} justify-self-start`}
						disabled={mutation.isPending || !name.trim()}
					>
						保存人物资料
					</button>
				</form>
			</details>
			<div>
				<h2 className="mb-3 font-bold">账号与频道</h2>
				<div className="grid gap-3 sm:grid-cols-2">
					{person.sources.map((source) => (
						<SourceRow
							key={source.id}
							source={source}
							pending={mutation.isPending}
							run={(action) => mutation.mutate(action)}
						/>
					))}
				</div>
				{!person.sources.length && (
					<p className="text-sm text-[var(--ink-soft)]">
						还没有账号或频道，可以先上传已有资料。
					</p>
				)}
			</div>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					if (url.trim())
						mutation.mutate({
							action: "addSource",
							personId: person.id,
							kind,
							url: url.trim(),
						});
				}}
				className="flex flex-wrap items-end gap-3"
			>
				<label className="grid gap-1 text-sm">
					来源平台
					<select
						className={textFieldClass}
						value={kind}
						onChange={(event) =>
							setKind(event.target.value as "x" | "telegram")
						}
					>
						<option value="telegram">Telegram</option>
						<option value="x">X / Twitter</option>
					</select>
				</label>
				<label className="grid min-w-48 flex-1 gap-1 text-sm">
					账号或频道链接
					<input
						required
						className={textFieldClass}
						value={url}
						placeholder={
							kind === "telegram"
								? "https://t.me/channel"
								: "https://x.com/username"
						}
						onChange={(event) => setUrl(event.target.value)}
					/>
				</label>
				<button
					className={`${primaryButtonClass} min-h-10`}
					disabled={mutation.isPending || !url.trim()}
				>
					<Plus size={16} />
					添加来源
				</button>
			</form>
			<ArchiveError error={mutation.error} />
			<PersonArchiveMerge person={person} />
		</div>
	);
}

function UploadForm({
	personId,
	onUploaded,
}: {
	personId: string;
	onUploaded: () => void;
}) {
	const formRef = useRef<HTMLFormElement>(null);
	const [mode, setMode] = useState<"file" | "text">("file");
	const [message, setMessage] = useState("");
	const upload = useMutation({
		mutationFn: uploadPersonFile,
		onSuccess: () => {
			formRef.current?.reset();
			setMessage("资料已保存，处理状态可在下方档案中查看。");
			onUploaded();
		},
	});
	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setMessage("");
		const form = new FormData(event.currentTarget);
		form.set("personId", personId);
		if (mode === "text") {
			const text = String(form.get("text") ?? "");
			if (!text.trim()) return;
			form.set(
				"file",
				new File([text], "historical-note.txt", { type: "text/plain" }),
			);
			form.delete("text");
		}
		for (const key of ["title", "publishedAt", "sourceUrl"])
			if (!String(form.get(key) ?? "").trim()) form.delete(key);
		upload.mutate(form);
	}
	return (
		<form
			ref={formRef}
			onSubmit={submit}
			className="grid gap-4 border-b border-[var(--line)] bg-[var(--panel)] p-5 sm:p-7"
		>
			<h2 className="font-bold">补充历史资料</h2>
			<div className="flex gap-2">
				<button
					type="button"
					className={secondaryButtonClass}
					aria-pressed={mode === "file"}
					onClick={() => setMode("file")}
				>
					上传文件
				</button>
				<button
					type="button"
					className={secondaryButtonClass}
					aria-pressed={mode === "text"}
					onClick={() => setMode("text")}
				>
					粘贴文字
				</button>
			</div>
			{mode === "file" ? (
				<label className="grid gap-2 text-sm">
					PDF 或文字文件（最大 20 MB）
					<input
						required
						type="file"
						name="file"
						accept=".pdf,.txt,.md,.csv,.json,application/pdf,text/plain,text/markdown"
						className="max-w-full text-sm"
					/>
					<span className="text-xs text-[var(--ink-soft)]">
						支持
						PDF、TXT、Markdown、CSV、JSON，保留原文件并提取文字。扫描件的提取结果以处理状态为准。
					</span>
				</label>
			) : (
				<label className="grid gap-1 text-sm">
					原文
					<textarea
						required
						name="text"
						rows={7}
						className={textFieldClass}
						placeholder="粘贴文章、采访、演讲或其他历史文字"
					/>
				</label>
			)}
			<label className="grid gap-1 text-sm">
				资料标题（可选）
				<input name="title" maxLength={500} className={textFieldClass} />
			</label>
			<div className="grid gap-3 sm:grid-cols-2">
				<label className="grid gap-1 text-sm">
					原始发布日期（可选）
					<input type="date" name="publishedAt" className={textFieldClass} />
				</label>
				<label className="grid gap-1 text-sm">
					原文链接（可选）
					<input
						type="url"
						name="sourceUrl"
						className={textFieldClass}
						placeholder="https://…"
					/>
				</label>
			</div>
			<ArchiveError error={upload.error} />
			{message && (
				<p role="status" className="text-sm text-[var(--accent)]">
					{message}
				</p>
			)}
			<button
				className={`${primaryButtonClass} justify-self-start`}
				disabled={upload.isPending}
			>
				<Upload size={16} />
				{upload.isPending ? "正在上传与处理…" : "保存到人物档案"}
			</button>
		</form>
	);
}

export function PersonRouteView({
	personId,
	documentId,
	onClearDocument,
}: {
	personId: string;
	documentId?: string;
	onClearDocument?: () => void;
}) {
	const client = useQueryClient();
	const [kind, setKind] = useState("all");
	const [query, setQuery] = useState("");
	const [settings, setSettings] = useState(false);
	const [upload, setUpload] = useState(false);
	const search = useDebouncedValue(query, 250);
	const refetchInterval = useArchivePollInterval();
	useArchiveEvents(personId);
	const detail = useQuery({
		queryKey: [...personArchiveKeys, "detail", personId],
		queryFn: () => fetchPerson(personId),
		refetchInterval,
	});
	const archive = useInfiniteQuery({
		queryKey: [
			...personArchiveKeys,
			"items",
			personId,
			kind,
			search,
			documentId,
		],
		queryFn: ({ pageParam }) =>
			fetchPersonItems(
				personId,
				documentId ? "document" : kind,
				documentId ? "" : search,
				pageParam,
				documentId ? `doc:${documentId}` : undefined,
			),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (page) => page.nextCursor ?? undefined,
	});
	const refresh = () => {
		void client.invalidateQueries({ queryKey: personArchiveKeys });
	};
	const read = useMutation({
		mutationFn: (throughSequence: number) =>
			personAction({ action: "read", personId, throughSequence }),
		onSuccess: refresh,
	});
	const person = detail.data?.person;
	const shownSequence = archive.data?.pages[0]?.latestSequence ?? 0;
	const newItems =
		person && person.latestSequence > shownSequence && Boolean(archive.data);
	const items = archive.data?.pages.flatMap((page) => page.items) ?? [];
	return (
		<section className="min-h-screen">
			<header className="border-b border-[var(--line)] p-5 sm:p-7">
				<Link
					to="/people"
					className="mb-4 inline-flex items-center gap-1 text-sm text-[var(--ink-soft)]"
				>
					<ArrowLeft size={16} />
					全部人物
				</Link>
				{person ? (
					<>
						<div className="flex flex-wrap items-start justify-between gap-3">
							<div className="min-w-0">
								<h1 className="break-words text-2xl font-bold">
									{person.name}
								</h1>
								<p className="mt-2 max-w-2xl whitespace-pre-wrap break-words text-sm text-[var(--ink-soft)]">
									{person.description || "跨平台人物档案"}
								</p>
							</div>
							<div className="flex flex-wrap gap-2">
								<button
									type="button"
									className={secondaryButtonClass}
									onClick={() => setSettings(!settings)}
									aria-expanded={settings}
								>
									管理来源
								</button>
								<button
									type="button"
									className={primaryButtonClass}
									onClick={() => setUpload(!upload)}
									aria-expanded={upload}
								>
									<Upload size={16} />
									上传资料
								</button>
							</div>
						</div>
						<div className="mt-4 flex flex-wrap gap-4 text-xs text-[var(--ink-soft)]">
							<span>{person.stats.items.toLocaleString()} 条内容</span>
							<span>{person.stats.documents} 份资料</span>
							<span>{person.stats.media} 个媒体</span>
							<span>{person.unreadCount} 条未读更新</span>
						</div>
					</>
				) : (
					<p role="status">
						{detail.isPending ? "正在读取人物档案…" : "人物档案暂时无法读取"}
					</p>
				)}
				<ArchiveError error={detail.error} />
			</header>
			{person && settings && (
				<PersonSettings key={person.id} person={person} onSaved={refresh} />
			)}
			{person && upload && (
				<UploadForm personId={personId} onUploaded={refresh} />
			)}
			{newItems && !documentId && (
				<button
					type="button"
					className="flex w-full items-center justify-center gap-2 border-b border-[var(--line)] bg-[var(--accent-soft)] px-5 py-3 text-sm font-semibold text-[var(--accent)]"
					onClick={() => void archive.refetch()}
				>
					<Bell size={16} />
					有新内容，点击刷新档案
				</button>
			)}
			{documentId ? (
				<div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] bg-[var(--accent-soft)] px-5 py-4 sm:px-7">
					<p className="text-sm font-semibold">正在查看引用资料</p>
					<button
						type="button"
						className={secondaryButtonClass}
						onClick={onClearDocument}
					>
						返回全部资料
					</button>
				</div>
			) : (
				<div className="flex flex-wrap items-center gap-3 border-b border-[var(--line)] px-5 py-4 sm:px-7">
					<label className="sr-only" htmlFor="archive-kind">
						内容来源
					</label>
					<select
						id="archive-kind"
						className={`${textFieldClass} w-auto`}
						value={kind}
						onChange={(event) => setKind(event.target.value)}
					>
						<option value="all">全部来源</option>
						<option value="x">X / Twitter</option>
						<option value="telegram">Telegram</option>
						<option value="document">历史资料</option>
					</select>
					<input
						aria-label="搜索人物内容"
						className={`${textFieldClass} min-w-40 flex-1`}
						placeholder="搜索这个人的历史内容"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
					{person && person.unreadCount > 0 && (
						<button
							type="button"
							className={secondaryButtonClass}
							disabled={read.isPending || !archive.data}
							onClick={() => read.mutate(shownSequence)}
						>
							<Check size={16} />
							标记当前更新已读
						</button>
					)}
				</div>
			)}
			<div className="px-5">
				<ArchiveError error={read.error} />
				<ArchiveError error={archive.error} />
			</div>
			{archive.isPending ? (
				<p role="status" className="py-12 text-center text-[var(--ink-soft)]">
					正在读取内容…
				</p>
			) : items.length === 0 ? (
				<div className="p-10 text-center text-[var(--ink-soft)]">
					<p>
						{documentId
							? "未找到这份引用资料"
							: search
								? "没有匹配的内容"
								: "这个档案暂时没有内容"}
					</p>
					<p className="mt-2 text-sm">
						{documentId
							? "资料可能已合并到其他人物，或此链接不属于当前人物档案。"
							: "添加来源后会自动采集，也可以上传历史资料。"}
					</p>
				</div>
			) : (
				items.map((item) => <PersonArchiveItem key={item.id} item={item} />)
			)}
			{archive.hasNextPage && (
				<div className="p-5 text-center">
					<button
						type="button"
						className={secondaryButtonClass}
						disabled={archive.isFetchingNextPage}
						onClick={() => void archive.fetchNextPage()}
					>
						{archive.isFetchingNextPage ? "读取中…" : "加载更早内容"}
					</button>
				</div>
			)}
		</section>
	);
}
