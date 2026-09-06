import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderWithQueryClient as render } from "#/test/render";
import type { PersonDetail, PersonItem } from "#/lib/person-archive-types";
import { PeopleRouteView } from "#/routes/people";
import { PersonRouteView } from "#/routes/people_.$personId";
import { PersonArchiveItem } from "./PersonArchiveItem";
import { PersonArchiveMerge } from "./PersonArchiveShared";

vi.mock("@tanstack/react-router", () => ({
	createFileRoute: () => (options: unknown) => options,
	Link: ({
		children,
		to,
		params,
	}: {
		children: ReactNode;
		to: string;
		params?: { personId: string };
	}) => (
		<a href={to.replace("$personId", params?.personId ?? "")}>{children}</a>
	),
	useNavigate: () => vi.fn(),
}));

const person: PersonDetail = {
	id: "person-1",
	name: "Ada",
	description: "Research archive",
	avatarUrl: null,
	itemCount: 1,
	unreadCount: 1,
	updatedAt: "2026-09-06T00:00:00Z",
	createdAt: "2026-09-01T00:00:00Z",
	latestSequence: 12,
	stats: { items: 1, media: 0, documents: 0, unread: 1 },
	sources: [
		{
			id: "tg-1",
			personId: "person-1",
			kind: "telegram",
			identifier: "ada_channel",
			url: "https://t.me/ada_channel",
			enabled: true,
			historyStatus: "public_history_exhausted",
			lastSyncedAt: null,
			lastError: null,
			itemCount: 1,
			mediaStoredCount: 0,
			mediaPendingCount: 0,
			mediaFailedCount: 0,
			coverage: "public_web",
		},
	],
};
const item: PersonItem = {
	id: "item-1",
	personId: person.id,
	sourceId: "tg-1",
	kind: "telegram",
	title: "",
	text: "Archived channel post",
	publishedAt: "2026-09-05T00:00:00Z",
	ingestedAt: "2026-09-06T00:00:00Z",
	sourceUrl: "https://t.me/ada_channel/1",
	media: [],
	ragStatus: "indexed",
	attribution: null,
};

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("Person archive", () => {
	it("opens an older cited document directly and offers the full archive", async () => {
		const urls: URL[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown) => {
				const url = new URL(String(input), "https://birdclaw.test");
				urls.push(url);
				if (url.pathname === "/api/person-items")
					return Response.json({
						ok: true,
						items: [
							{
								...item,
								id: "doc:old-document",
								kind: "document",
								text: "The old cited PDF",
								publishedAt: "2001-01-01T00:00:00Z",
							},
						],
						latestSequence: 10,
						nextCursor: null,
					});
				return Response.json({ ok: true, person });
			}),
		);
		const clear = vi.fn();
		render(
			<PersonRouteView
				personId={person.id}
				documentId="old-document"
				onClearDocument={clear}
			/>,
		);
		expect(await screen.findByText("The old cited PDF")).toBeVisible();
		expect(
			urls.some(
				(url) =>
					url.searchParams.get("personId") === person.id &&
					url.searchParams.get("itemId") === "doc:old-document" &&
					url.searchParams.get("kind") === "document",
			),
		).toBe(true);
		expect(screen.getByText("正在查看引用资料")).toBeVisible();
		expect(screen.queryByLabelText("搜索人物内容")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "标记当前更新已读" }),
		).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "返回全部资料" }));
		expect(clear).toHaveBeenCalledOnce();
	});

	it("receives visible live events without replacing the archive and closes hidden streams", async () => {
		class FakeEventSource extends EventTarget {
			static instances: FakeEventSource[] = [];
			url: string;
			close = vi.fn();
			onerror: (() => void) | null = null;
			constructor(url: string) {
				super();
				this.url = url;
				FakeEventSource.instances.push(this);
			}
		}
		vi.stubGlobal("EventSource", FakeEventSource);
		const visibility = vi
			.spyOn(document, "visibilityState", "get")
			.mockReturnValue("visible");
		let detailRequests = 0;
		let itemRequests = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown) => {
				if (String(input).startsWith("/api/person-items")) {
					itemRequests++;
					return Response.json({
						ok: true,
						items: [item],
						latestSequence: 10,
						nextCursor: null,
					});
				}
				detailRequests++;
				return Response.json({
					ok: true,
					person: { ...person, latestSequence: detailRequests === 1 ? 10 : 12 },
				});
			}),
		);
		const view = render(<PersonRouteView personId={person.id} />);
		expect(await screen.findByText("Archived channel post")).toBeVisible();
		expect(
			screen.queryByRole("button", { name: "有新内容，点击刷新档案" }),
		).not.toBeInTheDocument();
		const first = FakeEventSource.instances[0];
		expect(first.url).toBe("/api/person-events?personId=person-1");
		first.dispatchEvent(
			new MessageEvent("archive-updated", { data: "malformed" }),
		);
		first.dispatchEvent(
			new MessageEvent("archive-updated", {
				data: JSON.stringify({ personId: person.id, latestSequence: 12 }),
			}),
		);
		expect(
			await screen.findByRole("button", { name: "有新内容，点击刷新档案" }),
		).toBeVisible();
		expect(itemRequests).toBe(1);
		expect(FakeEventSource.instances).toHaveLength(1);
		visibility.mockReturnValue("hidden");
		fireEvent(document, new Event("visibilitychange"));
		expect(first.close).toHaveBeenCalledOnce();
		visibility.mockReturnValue("visible");
		fireEvent(document, new Event("visibilitychange"));
		expect(FakeEventSource.instances[1].url).toBe(
			"/api/person-events?personId=person-1&after=12",
		);
		view.unmount();
		expect(FakeEventSource.instances[1].close).toHaveBeenCalledOnce();
	});

	it("paginates the full people directory and requests unread filtering on the server", async () => {
		const requests: URL[] = [];
		const nextPerson = { ...person, id: "person-2", name: "Grace" };
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown) => {
				const url = new URL(String(input), "https://birdclaw.test");
				requests.push(url);
				if (url.searchParams.get("unread") === "1")
					return Response.json({
						ok: true,
						people: [nextPerson],
						total: 1,
						nextCursor: null,
					});
				return Response.json({
					ok: true,
					people: url.searchParams.has("before") ? [nextPerson] : [person],
					total: 2,
					nextCursor: url.searchParams.has("before") ? null : "page-two",
				});
			}),
		);
		render(<PeopleRouteView onCreated={vi.fn()} />);
		expect(await screen.findByText("共 2 位人物 · 已显示 1 位")).toBeVisible();
		fireEvent.click(screen.getByRole("button", { name: "加载更多人物" }));
		expect(await screen.findByText("Grace")).toBeVisible();
		expect(
			requests.some((url) => url.searchParams.get("before") === "page-two"),
		).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: "只看未读" }));
		expect(
			await screen.findByText("共 1 位有未读更新的人物 · 已显示 1 位"),
		).toBeVisible();
		expect(screen.queryByText("Ada")).not.toBeInTheDocument();
	});

	it("requires a concrete surviving person before merging", async () => {
		const actions: unknown[] = [];
		const survivor = { ...person, id: "person-x", name: "Ada X" };
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: unknown, init?: RequestInit) => {
				if (init?.method === "POST") {
					actions.push(JSON.parse(String(init.body)));
					return Response.json({ ok: true, person: survivor });
				}
				return Response.json({
					ok: true,
					people: [person, survivor],
					nextCursor: null,
					total: 2,
				});
			}),
		);
		render(<PersonArchiveMerge person={person} />);
		fireEvent.click(screen.getByRole("button", { name: "合并到另一人物" }));
		expect(await screen.findByText("Ada X")).toBeVisible();
		expect(actions).toHaveLength(0);
		expect(
			screen.queryByRole("button", { name: "确认合并到「Ada X」" }),
		).not.toBeInTheDocument();
		fireEvent.click(
			screen.getByRole("button", { name: "选择保留人物：Ada X" }),
		);
		expect(actions).toHaveLength(0);
		fireEvent.click(
			screen.getByRole("button", { name: "确认合并到「Ada X」" }),
		);
		await waitFor(() =>
			expect(actions).toEqual([
				{ action: "merge", personId: person.id, targetPersonId: survivor.id },
			]),
		);
	});

	it("creates a Telegram-only person and also permits a name-only archive", async () => {
		const actions: unknown[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: unknown, init?: RequestInit) => {
				if (init?.method === "POST") {
					actions.push(JSON.parse(String(init.body)));
					return Response.json({ ok: true, person });
				}
				return Response.json({ ok: true, people: [] });
			}),
		);
		const created = vi.fn();
		render(<PeopleRouteView onCreated={created} />);
		fireEvent.click(screen.getByRole("button", { name: "新增人物" }));
		fireEvent.change(screen.getByLabelText("姓名"), {
			target: { value: "Ada" },
		});
		fireEvent.click(screen.getByRole("button", { name: "创建档案" }));
		await waitFor(() => expect(actions).toHaveLength(1));
		expect(actions[0]).toEqual({
			action: "create",
			name: "Ada",
			description: "",
		});
		await waitFor(() => expect(created).toHaveBeenCalledWith(person.id));
		fireEvent.change(screen.getByLabelText("首个来源"), {
			target: { value: "telegram" },
		});
		fireEvent.change(screen.getByLabelText("账号或频道链接（可稍后添加）"), {
			target: { value: "https://t.me/ada_channel" },
		});
		fireEvent.click(screen.getByRole("button", { name: "创建档案" }));
		await waitFor(() => expect(actions).toHaveLength(2));
		expect(actions[1]).toMatchObject({
			kind: "telegram",
			url: "https://t.me/ada_channel",
		});
	});

	it("uploads pasted text, pauses a source and marks only the displayed watermark read", async () => {
		const actions: unknown[] = [];
		let uploaded: FormData | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: RequestInit) => {
				const url = new URL(String(input), "https://birdclaw.test");
				if (url.pathname === "/api/person-files") {
					uploaded = init?.body as FormData;
					return Response.json({ ok: true, item });
				}
				if (init?.method === "POST") {
					actions.push(JSON.parse(String(init.body)));
					return Response.json({ ok: true, person });
				}
				if (url.pathname === "/api/person-items")
					return Response.json({
						ok: true,
						items: [item],
						latestSequence: 10,
						nextCursor: null,
					});
				return Response.json({ ok: true, person });
			}),
		);
		render(<PersonRouteView personId={person.id} />);
		expect(await screen.findByText("Archived channel post")).toBeVisible();
		expect(screen.getByText("频道发布 · 未单独核实作者")).toBeVisible();
		expect(
			screen.getByRole("button", { name: "有新内容，点击刷新档案" }),
		).toBeVisible();
		fireEvent.click(screen.getByRole("button", { name: "标记当前更新已读" }));
		await waitFor(() =>
			expect(actions).toContainEqual({
				action: "read",
				personId: person.id,
				throughSequence: 10,
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "管理来源" }));
		expect(screen.getByText("公开可见历史已遍历")).toBeVisible();
		fireEvent.click(screen.getByRole("button", { name: "暂停同步" }));
		await waitFor(() =>
			expect(actions).toContainEqual({
				action: "sourceState",
				sourceId: "tg-1",
				enabled: false,
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "上传资料" }));
		fireEvent.click(screen.getByRole("button", { name: "粘贴文字" }));
		fireEvent.change(screen.getByLabelText("原文"), {
			target: { value: "An old interview" },
		});
		fireEvent.click(screen.getByRole("button", { name: "保存到人物档案" }));
		await waitFor(() => expect(uploaded).toBeDefined());
		expect(uploaded?.get("personId")).toBe(person.id);
		expect((uploaded?.get("file") as File | undefined)?.name).toBe(
			"historical-note.txt",
		);
		expect(uploaded?.has("publishedAt")).toBe(false);
	});

	it("never renders executable source or document URLs", () => {
		render(
			<PersonArchiveItem
				item={{
					...item,
					sourceUrl: "javascript:alert(1)",
					document: {
						filename: "source.pdf",
						downloadUrl: "javascript:alert(1)",
						extractionStatus: "needs_ocr",
					},
				}}
			/>,
		);
		expect(screen.queryByRole("link")).not.toBeInTheDocument();
		expect(screen.getByText("文字提取：需要 OCR")).toBeVisible();
	});

	it("labels truncated previews, forwarded posts and unavailable media accurately", () => {
		render(
			<PersonArchiveItem
				item={{
					...item,
					text: "A".repeat(6000),
					textTruncated: true,
					attribution: "forwarded",
					ragStatus: "media_only",
					media: [
						{
							id: "missing-media",
							kind: "video",
							mimeType: "video/mp4",
							url: null,
							remoteUrl: "https://t.me/example",
							storageStatus: "unavailable",
						},
					],
				}}
			/>,
		);
		expect(screen.getByRole("button", { name: "展开预览" })).toBeVisible();
		expect(
			screen.queryByRole("button", { name: "展开全文" }),
		).not.toBeInTheDocument();
		expect(screen.getByText("频道转发 · 原作者以来源为准")).toBeVisible();
		expect(screen.getByText("索引：仅有媒体，暂无可索引文字")).toBeVisible();
		expect(
			screen.getByText(
				"此处显示正文预览，完整内容可打开原始文件；检索包含已提取全文。",
			),
		).toBeVisible();
		fireEvent.click(screen.getByRole("button", { name: "查看 1 个媒体资源" }));
		expect(screen.getByText("无法取得原件，可在来源中重试")).toBeVisible();
	});
});
