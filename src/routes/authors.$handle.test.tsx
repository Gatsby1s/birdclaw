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
		expect(screen.getByRole("link", { name: "Analyse" })).toHaveAttribute(
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
});
