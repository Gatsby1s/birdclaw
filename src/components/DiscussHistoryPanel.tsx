import {
	Clock3,
	History,
	MessageCircle,
	Pin,
	Search,
	Trash2,
	X,
} from "lucide-react";
import { cx, searchFieldIconClass, searchFieldInputClass } from "#/lib/ui";

export interface DiscussHistoryListItem {
	id: string;
	title: string;
	summary: string;
	query: string;
	question?: string;
	source: string;
	mode: string;
	range: "all" | "today" | "24h" | "yesterday" | "week" | "custom";
	since?: string;
	until?: string;
	includeDms: boolean;
	themeTitles: string[];
	sourceCount: number;
	dmCount: number;
	createdAt: string;
	updatedAt: string;
	parentId: string | null;
	pinned: boolean;
	versionCount: number;
}

function localDateKey(value: string) {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "older";
	return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function historyGroup(value: string, now = new Date()) {
	const today = localDateKey(now.toISOString());
	const yesterdayDate = new Date(now);
	yesterdayDate.setDate(yesterdayDate.getDate() - 1);
	const yesterday = localDateKey(yesterdayDate.toISOString());
	const itemDate = localDateKey(value);
	if (itemDate === today) return "Today";
	if (itemDate === yesterday) return "Yesterday";
	return "Earlier";
}

function historyTime(value: string) {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "";
	const showDate = historyGroup(value) === "Earlier";
	return new Intl.DateTimeFormat(undefined, {
		...(showDate ? { month: "short" as const, day: "numeric" as const } : {}),
		hour: "2-digit",
		minute: "2-digit",
	}).format(date);
}

function sourceLabel(value: string) {
	if (value === "search") return "Live search";
	if (value === "all") return "All local";
	return value.charAt(0).toUpperCase() + value.slice(1);
}

function HistoryRow({
	item,
	active,
	onSelect,
	onDelete,
	onTogglePin,
}: {
	item: DiscussHistoryListItem;
	active: boolean;
	onSelect: (id: string) => void;
	onDelete: (id: string) => void;
	onTogglePin: (item: DiscussHistoryListItem) => void;
}) {
	return (
		<article
			className={cx(
				"group relative border-b border-[var(--line)] transition-colors hover:bg-[var(--bg-hover)]",
				active &&
					"bg-[var(--accent-soft)] shadow-[inset_3px_0_0_var(--accent)]",
			)}
		>
			<button
				type="button"
				aria-pressed={active}
				className="w-full px-4 py-3 pr-16 text-left"
				onClick={() => onSelect(item.id)}
			>
				<div className="flex min-w-0 items-center gap-2">
					<h3 className="min-w-0 flex-1 truncate text-[14px] font-bold text-[var(--ink)]">
						{item.title}
					</h3>
					<time
						className="shrink-0 text-[11px] text-[var(--ink-soft)]"
						dateTime={item.createdAt}
					>
						{historyTime(item.createdAt)}
					</time>
				</div>
				<p className="mt-1 line-clamp-2 text-[13px] leading-[1.35] text-[var(--ink-soft)]">
					{item.summary}
				</p>
				{item.themeTitles.length > 0 ? (
					<div className="mt-2 flex min-w-0 gap-1 overflow-hidden">
						{item.themeTitles.slice(0, 2).map((theme) => (
							<span
								key={theme}
								className="max-w-[132px] truncate rounded-full border border-[var(--line)] bg-[var(--bg)] px-2 py-0.5 text-[10px] font-semibold text-[var(--ink-soft)]"
							>
								{theme}
							</span>
						))}
					</div>
				) : null}
				<div className="mt-2 flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--ink-soft)]">
					<span className="truncate">{sourceLabel(item.source)}</span>
					<span aria-hidden="true">·</span>
					<span className="shrink-0">{item.sourceCount} sources</span>
					{item.dmCount > 0 ? (
						<>
							<span aria-hidden="true">·</span>
							<span className="inline-flex shrink-0 items-center gap-0.5">
								<MessageCircle className="size-3" aria-hidden="true" />
								{item.dmCount}
							</span>
						</>
					) : null}
					{item.versionCount > 1 ? (
						<>
							<span aria-hidden="true">·</span>
							<span className="shrink-0">{item.versionCount} versions</span>
						</>
					) : null}
				</div>
			</button>
			<div className="absolute right-2 top-2 flex items-center gap-0.5 opacity-100 min-[1240px]:opacity-0 min-[1240px]:transition-opacity min-[1240px]:group-hover:opacity-100 min-[1240px]:group-focus-within:opacity-100">
				<button
					type="button"
					aria-label={item.pinned ? `Unpin ${item.title}` : `Pin ${item.title}`}
					className={cx(
						"grid size-7 place-items-center rounded-full text-[var(--ink-soft)] hover:bg-[var(--bg-active)] hover:text-[var(--ink)]",
						item.pinned && "text-[var(--accent)]",
					)}
					onClick={() => onTogglePin(item)}
				>
					<Pin className="size-3.5" aria-hidden="true" />
				</button>
				<button
					type="button"
					aria-label={`Delete ${item.title}`}
					className="grid size-7 place-items-center rounded-full text-[var(--ink-soft)] hover:bg-[var(--alert-soft)] hover:text-[var(--alert)]"
					onClick={() => onDelete(item.id)}
				>
					<Trash2 className="size-3.5" aria-hidden="true" />
				</button>
			</div>
		</article>
	);
}

export function DiscussHistoryPanel({
	items,
	activeId,
	loading,
	error,
	filter,
	onFilterChange,
	onSelect,
	onDelete,
	onTogglePin,
	onClose,
}: {
	items: DiscussHistoryListItem[];
	activeId: string;
	loading: boolean;
	error: string | null;
	filter: string;
	onFilterChange: (value: string) => void;
	onSelect: (id: string) => void;
	onDelete: (id: string) => void;
	onTogglePin: (item: DiscussHistoryListItem) => void;
	onClose?: () => void;
}) {
	const normalizedFilter = filter.trim().toLocaleLowerCase();
	const filteredItems = normalizedFilter
		? items.filter((item) =>
				[
					item.title,
					item.summary,
					item.query,
					item.question ?? "",
					...item.themeTitles,
				]
					.join(" ")
					.toLocaleLowerCase()
					.includes(normalizedFilter),
			)
		: items;
	const groupedItems = ["Today", "Yesterday", "Earlier"]
		.map((group) => ({
			group,
			items: filteredItems.filter(
				(item) => historyGroup(item.createdAt) === group,
			),
		}))
		.filter((section) => section.items.length > 0);

	return (
		<aside
			aria-label="Discussion history"
			className="flex h-full min-h-0 flex-col bg-[var(--bg)]"
		>
			<header className="border-b border-[var(--line)] px-3 pb-3 pt-3">
				<div className="flex items-center gap-2 px-1">
					<History
						className="size-4 text-[var(--ink-soft)]"
						aria-hidden="true"
					/>
					<h2 className="flex-1 text-[15px] font-bold text-[var(--ink)]">
						History
					</h2>
					<span className="text-[11px] text-[var(--ink-soft)]">
						{items.length}
					</span>
					{onClose ? (
						<button
							type="button"
							aria-label="Close history"
							className="grid size-8 place-items-center rounded-full text-[var(--ink-soft)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink)]"
							onClick={onClose}
						>
							<X className="size-4" aria-hidden="true" />
						</button>
					) : null}
				</div>
				<label className="mt-3 flex items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--bg-active)] px-3 py-2 focus-within:border-[var(--accent)]">
					<Search className={searchFieldIconClass} aria-hidden="true" />
					<input
						className={searchFieldInputClass}
						aria-label="Search discussion history"
						placeholder="Search history"
						value={filter}
						onChange={(event) => onFilterChange(event.currentTarget.value)}
					/>
				</label>
			</header>

			<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
				{loading && items.length === 0 ? (
					<div className="flex items-center gap-2 px-4 py-5 text-[13px] text-[var(--ink-soft)]">
						<Clock3 className="size-4 animate-pulse" aria-hidden="true" />
						Loading saved discussions…
					</div>
				) : error ? (
					<p className="px-4 py-5 text-[13px] text-[var(--alert)]">{error}</p>
				) : filteredItems.length === 0 ? (
					<div className="px-4 py-8 text-center">
						<p className="text-[13px] font-semibold text-[var(--ink)]">
							{items.length === 0 ? "No saved discussions yet" : "No matches"}
						</p>
						<p className="mt-1 text-[12px] leading-relaxed text-[var(--ink-soft)]">
							{items.length === 0
								? "Completed discussions will appear here automatically."
								: "Try another title, keyword, or theme."}
						</p>
					</div>
				) : (
					groupedItems.map((section) => (
						<section key={section.group} aria-label={section.group}>
							<h3 className="sticky top-0 z-10 border-b border-[var(--line)] bg-[var(--bg)] px-4 py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--ink-soft)]">
								{section.group}
							</h3>
							{section.items.map((item) => (
								<HistoryRow
									key={item.id}
									item={item}
									active={item.id === activeId}
									onSelect={onSelect}
									onDelete={onDelete}
									onTogglePin={onTogglePin}
								/>
							))}
						</section>
					))
				)}
			</div>
		</aside>
	);
}
