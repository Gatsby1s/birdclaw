import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithQueryClient as render } from "#/test/render";

vi.mock("#/components/TimelineCard", () => ({
	TimelineCard: ({ item }: { item: { id: string; text: string } }) => (
		<article data-testid={item.id}>{item.text}</article>
	),
}));

import { AuthorTimelineRouteView } from "./authors.$handle";

afterEach(() => {
	cleanup();
	window.localStorage.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function timelineItem(id: string, text: string) {
	return {
		id,
		accountId: "acct_primary",
		accountHandle: "primary",
		kind: "home",
		text,
		createdAt: "2026-07-31T12:00:00.000Z",
		isReplied: false,
		likeCount: 0,
		mediaCount: 0,
		bookmarked: false,
		liked: false,
		author: {
			id: "profile_alice",
			handle: "Alice",
			displayName: "Alice Local",
			bio: "Stored locally.",
			followersCount: 1200,
			followingCount: 42,
			avatarHue: 18,
			createdAt: "2020-01-01T00:00:00.000Z",
		},
		entities: {},
		media: [],
	};
}

describe("author local timeline route", () => {
	it("loads only the selected author's local history without profile analysis", async () => {
		window.localStorage.setItem("birdclaw:selected-account-id", "acct_studio");
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input), "http://localhost");
			if (url.pathname === "/api/profile-priority") {
				return Response.json({ handle: "alice", specialFollow: false });
			}
			if (url.pathname === "/api/xremark") {
				return Response.json({
					imported: false,
					annotationCount: 0,
					matchedProfileCount: 0,
					annotation: null,
				});
			}
			if (url.pathname === "/api/status") {
				return Response.json({
					stats: { home: 2, mentions: 0, dms: 0, needsReply: 0, inbox: 0 },
					transport: { statusText: "local" },
					accounts: [
						{
							id: "acct_primary",
							name: "Primary",
							handle: "@primary",
							transport: "archive",
							isDefault: 1,
							createdAt: "2026-07-31T00:00:00.000Z",
						},
						{
							id: "acct_studio",
							name: "Studio",
							handle: "@studio",
							transport: "archive",
							isDefault: 0,
							createdAt: "2026-07-31T00:00:00.000Z",
						},
					],
					archives: [],
				});
			}
			if (url.pathname === "/api/query") {
				return Response.json({
					resource: "home",
					items: [timelineItem("tweet_alice_1", "Alice history")],
				});
			}
			throw new Error(`Unexpected fetch ${url.toString()}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<AuthorTimelineRouteView handle="@Alice" />);

		expect(await screen.findByText("Alice history")).toBeInTheDocument();
		expect(screen.getAllByText("Alice Local").length).toBeGreaterThan(0);
		expect(screen.getByText("@Alice")).toBeInTheDocument();
		expect(screen.getByText("Stored locally.")).toBeInTheDocument();
		expect(
			await screen.findByRole("button", { name: "特别关注" }),
		).toHaveAttribute("aria-pressed", "false");
		expect(screen.getByRole("link", { name: "Analyse" })).toHaveAttribute(
			"href",
			"/profiles/Alice",
		);
		expect(screen.getByRole("link", { name: "Analysis" })).toHaveAttribute(
			"href",
			"/profiles/Alice",
		);
		await waitFor(() => {
			const queryCall = fetchMock.mock.calls.find(([input]) =>
				String(input).includes("/api/query"),
			);
			expect(queryCall).toBeDefined();
			const url = new URL(String(queryCall?.[0]));
			expect(url.searchParams.get("author")).toBe("Alice");
			expect(url.searchParams.get("resource")).toBe("home");
		});
		await waitFor(() => {
			const queryUrls = fetchMock.mock.calls
				.map(([input]) => new URL(String(input), "http://localhost"))
				.filter((url) => url.pathname === "/api/query");
			expect(
				queryUrls.some(
					(url) => url.searchParams.get("stateAccount") === "acct_studio",
				),
			).toBe(true);
		});
		expect(
			fetchMock.mock.calls.some(([input]) =>
				String(input).includes("/api/profile-analysis"),
			),
		).toBe(false);

		fireEvent.change(
			screen.getByPlaceholderText("Search @Alice's local posts"),
			{ target: { value: "history" } },
		);
		await waitFor(() => {
			const queryUrls = fetchMock.mock.calls
				.map(([input]) => String(input))
				.filter((url) => url.includes("/api/query"));
			expect(queryUrls.some((url) => url.includes("search=history"))).toBe(
				true,
			);
		});
	});

	it("edits a private note directly on the author timeline", async () => {
		let storedRemark = "Original note";
		let storedDescription = "Original description";
		let storedTags = ["Founder"];
		let patchBody: Record<string, unknown> | null = null;
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/profile-priority") {
					return Response.json({ handle: "alice", specialFollow: false });
				}
				if (url.pathname === "/api/xremark") {
					if (init?.method === "PATCH") {
						patchBody = JSON.parse(String(init.body)) as Record<
							string,
							unknown
						>;
						storedRemark = String(patchBody.remark);
						storedDescription = String(patchBody.description);
						storedTags = patchBody.tags as string[];
					}
					return Response.json({
						imported: true,
						annotationCount: 1,
						matchedProfileCount: 1,
						annotation: {
							identifier: "profile_alice",
							handle: "Alice",
							remark: storedRemark,
							description: storedDescription,
							tags: storedTags,
						},
					});
				}
				if (url.pathname === "/api/status") {
					return Response.json({
						stats: {
							home: 1,
							mentions: 0,
							dms: 0,
							needsReply: 0,
							inbox: 0,
						},
						transport: { statusText: "local" },
						accounts: [],
						archives: [],
					});
				}
				if (url.pathname === "/api/query") {
					return Response.json({
						resource: "home",
						items: [timelineItem("tweet_alice_note", "Alice note history")],
					});
				}
				throw new Error(`Unexpected fetch ${url.toString()}`);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		render(<AuthorTimelineRouteView handle="Alice" />);

		expect(await screen.findByText("Original note")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
		const remark = screen.getByRole("textbox", { name: "Remark" });
		const description = screen.getByRole("textbox", { name: "Description" });
		expect(remark).toHaveValue("Original note");
		expect(description).toHaveValue("Original description");
		expect(remark).toHaveAttribute("maxlength", "80");
		expect(description).toHaveAttribute("maxlength", "300");
		expect(screen.getByRole("button", { name: "交易员" })).toHaveAttribute(
			"aria-pressed",
			"false",
		);
		fireEvent.click(screen.getByRole("button", { name: "交易员" }));
		expect(screen.getByRole("button", { name: "交易员" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		fireEvent.change(screen.getByRole("textbox", { name: "Custom tag" }), {
			target: { value: "宏观" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add" }));
		fireEvent.change(remark, { target: { value: "Updated on mobile" } });
		fireEvent.change(description, {
			target: { value: "Updated mobile description" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save note" }));

		await waitFor(() => expect(patchBody).not.toBeNull());
		expect(await screen.findByText("Updated on mobile")).toBeInTheDocument();
		expect(
			await screen.findByText("Updated mobile description"),
		).toBeInTheDocument();
		expect(patchBody).toMatchObject({
			identifier: "profile_alice",
			handle: "Alice",
			remark: "Updated on mobile",
			description: "Updated mobile description",
			tags: ["Founder", "交易员", "宏观"],
		});
		expect(await screen.findByText("#交易员")).toBeInTheDocument();
		expect(await screen.findByText("#宏观")).toBeInTheDocument();
	});

	it("waits for both existing note fields before enabling edits", async () => {
		let resolveXRemark: (() => void) | undefined;
		const xRemarkReady = new Promise<void>((resolve) => {
			resolveXRemark = resolve;
		});
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input), "http://localhost");
			if (url.pathname === "/api/profile-priority") {
				return Response.json({ handle: "alice", specialFollow: false });
			}
			if (url.pathname === "/api/xremark") {
				await xRemarkReady;
				return Response.json({
					imported: true,
					annotationCount: 1,
					matchedProfileCount: 1,
					annotation: {
						identifier: "profile_alice",
						handle: "Alice",
						remark: "Existing remark",
						description: "Existing description",
						tags: [],
					},
				});
			}
			if (url.pathname === "/api/status") {
				return Response.json({
					stats: { home: 1, mentions: 0, dms: 0, needsReply: 0, inbox: 0 },
					transport: { statusText: "local" },
					accounts: [],
					archives: [],
				});
			}
			if (url.pathname === "/api/query") {
				return Response.json({
					resource: "home",
					items: [timelineItem("tweet_alice_loading", "Alice history")],
				});
			}
			throw new Error(`Unexpected fetch ${url.toString()}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<AuthorTimelineRouteView handle="Alice" />);

		expect(await screen.findByText("Alice history")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Loading note…" }),
		).toBeDisabled();
		expect(
			screen.queryByRole("textbox", { name: "Remark" }),
		).not.toBeInTheDocument();

		resolveXRemark?.();
		const editButton = await screen.findByRole("button", { name: "Edit note" });
		expect(editButton).toBeEnabled();
		fireEvent.click(editButton);
		expect(screen.getByRole("textbox", { name: "Remark" })).toHaveValue(
			"Existing remark",
		);
		expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue(
			"Existing description",
		);
	});
});
