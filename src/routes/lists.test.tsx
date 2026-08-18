import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithQueryClient as render } from "#/test/render";
import { ListsRouteView } from "./lists";

vi.mock("#/components/TimelineCard", () => ({
	TimelineCard: ({ item }: { item: { id: string; text: string } }) => (
		<article data-testid={item.id}>{item.text}</article>
	),
}));

function statusPayload() {
	return {
		accounts: [
			{
				id: "acct",
				name: "Primary",
				handle: "@primary",
				transport: "archive",
				isDefault: 1,
				createdAt: "2026-08-18T00:00:00.000Z",
			},
		],
		archives: [],
		transport: {
			installed: true,
			availableTransport: "local",
			statusText: "ready",
		},
		bookmarkSyncMode: "manual",
		stats: { home: 1, mentions: 0, dms: 0, needsReply: 0, inbox: 0 },
	};
}

const profile = {
	id: "profile_user_42",
	handle: "facts_wire",
	displayName: "Facts Wire",
	bio: "Editorial facts",
	followersCount: 100,
	followingCount: 10,
	avatarHue: 42,
	createdAt: "2026-08-18T00:00:00.000Z",
};

afterEach(() => {
	cleanup();
	window.localStorage.clear();
	vi.unstubAllGlobals();
});

describe("Lists route", () => {
	it("creates a List, adds a member, and keeps the local-sync boundary clear", async () => {
		let list:
			| {
					id: string;
					accountId: string;
					name: string;
					description: string;
					memberCount: number;
					createdAt: string;
					updatedAt: string;
			  }
			| undefined;
		let included = false;
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/status")
					return Response.json(statusPayload());
				if (url.pathname === "/api/lists" && init?.method === "POST") {
					const body = JSON.parse(String(init.body)) as {
						name: string;
						description: string;
					};
					list = {
						id: "list-facts",
						accountId: "acct",
						name: body.name,
						description: body.description,
						memberCount: included ? 1 : 0,
						createdAt: "2026-08-18T00:00:00.000Z",
						updatedAt: "2026-08-18T00:00:00.000Z",
					};
					return Response.json(list, { status: 201 });
				}
				if (url.pathname === "/api/lists") {
					return Response.json({
						lists: list ? [{ ...list, memberCount: included ? 1 : 0 }] : [],
					});
				}
				if (url.pathname === "/api/list-members" && init?.method === "PATCH") {
					included = Boolean(
						(JSON.parse(String(init.body)) as { included: boolean }).included,
					);
					return Response.json({ ok: true });
				}
				if (url.pathname === "/api/list-members") {
					return Response.json({
						list: { ...list, memberCount: included ? 1 : 0 },
						members: included
							? [
									{
										listId: "list-facts",
										memberKey: "id:42",
										identifier: "42",
										handle: "facts_wire",
										addedAt: "2026-08-18T00:00:00.000Z",
										updatedAt: "2026-08-18T00:00:00.000Z",
										profile,
									},
								]
							: [],
						candidates: url.searchParams.get("search")
							? [{ profile, included }]
							: [],
					});
				}
				throw new Error(`Unexpected fetch ${url.toString()}`);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		render(<ListsRouteView />);
		expect(await screen.findByText("还没有 Lists")).toBeVisible();
		fireEvent.change(screen.getByLabelText("名称"), {
			target: { value: "美股事实源" },
		});
		fireEvent.change(screen.getByLabelText("说明（可选）"), {
			target: { value: "公司与媒体" },
		});
		fireEvent.click(screen.getByRole("button", { name: "创建" }));

		expect(
			await screen.findByRole("heading", { name: "美股事实源" }),
		).toBeVisible();
		expect(screen.getByText("Members")).toBeVisible();
		fireEvent.change(screen.getByLabelText("Search profiles to add"), {
			target: { value: "facts" },
		});
		expect(await screen.findByText("Facts Wire")).toBeVisible();
		fireEvent.click(screen.getByRole("button", { name: "加入" }));
		await waitFor(() => expect(screen.getByText("成员 · 1")).toBeVisible());

		fireEvent.click(screen.getByRole("button", { name: "Posts" }));
		expect(
			screen.getByText("显示 BirdClaw 已同步的成员推文；刷新 Home 后会更新。"),
		).toBeVisible();
	});

	it("redirects an invalid selected List back to the index without mutating during render", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input), "http://localhost");
				return Response.json(
					url.pathname === "/api/status" ? statusPayload() : { lists: [] },
				);
			}),
		);
		const onSearchChange = vi.fn();
		render(
			<ListsRouteView
				onSearchChange={onSearchChange}
				searchState={{ list: "missing", tab: "posts" }}
			/>,
		);
		expect(await screen.findByText("还没有 Lists")).toBeVisible();
		await waitFor(() =>
			expect(onSearchChange).toHaveBeenCalledWith(
				{ list: "", tab: "posts" },
				true,
			),
		);
	});
});
