import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithQueryClient as render } from "#/test/render";
import { ProfileListsButton } from "./ProfileListsButton";

const status = {
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
	stats: { home: 0, mentions: 0, dms: 0, needsReply: 0, inbox: 0 },
};

afterEach(() => {
	cleanup();
	window.localStorage.clear();
	vi.unstubAllGlobals();
});

describe("ProfileListsButton", () => {
	it("adds a profile to a private List without exposing a credential", async () => {
		let included = false;
		const writes: unknown[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/status") return Response.json(status);
				if (url.pathname === "/api/list-members" && init?.method === "PATCH") {
					const body = JSON.parse(String(init.body)) as { included: boolean };
					writes.push(body);
					included = body.included;
					return Response.json({ ok: true });
				}
				if (url.pathname === "/api/list-members") {
					return Response.json({
						profile: { handle: "facts_wire", identifier: "42" },
						lists: [
							{
								id: "list-facts",
								accountId: "acct",
								name: "Facts",
								description: "",
								memberCount: included ? 1 : 0,
								createdAt: "2026-08-18T00:00:00.000Z",
								updatedAt: "2026-08-18T00:00:00.000Z",
								included,
							},
						],
					});
				}
				throw new Error(`Unexpected fetch ${url.toString()}`);
			}),
		);

		render(
			<ProfileListsButton handle="facts_wire" identifier="profile_user_42" />,
		);
		fireEvent.click(await screen.findByText("加入列表"));
		const checkbox = await screen.findByRole("checkbox");
		expect(checkbox).not.toBeChecked();
		fireEvent.click(checkbox);
		await waitFor(() => expect(writes).toHaveLength(1));
		expect(writes[0]).toMatchObject({
			accountId: "acct",
			listId: "list-facts",
			handle: "facts_wire",
			identifier: "profile_user_42",
			included: true,
		});
		expect(
			screen.getByRole("link", { name: "创建或管理 Lists" }),
		).toHaveAttribute("href", "/lists");
	});
});
