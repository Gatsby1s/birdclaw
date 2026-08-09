import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQueryClient as render } from "#/test/render";
import { SavedTimelineView } from "./SavedTimelineView";

vi.mock("#/components/TimelineCard", () => ({
	TimelineCard: ({
		item,
		onReply,
	}: {
		item: { id: string; text: string };
		onReply?: (tweetId: string) => void;
	}) => (
		<article>
			<span>{item.text}</span>
			{onReply ? (
				<button onClick={() => onReply(item.id)} type="button">
					reply {item.id}
				</button>
			) : null}
		</article>
	),
}));

describe("SavedTimelineView", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		cleanup();
	});

	it("loads liked posts through the query API", async () => {
		const queryUrls: URL[] = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/status")) {
				return new Response(
					JSON.stringify({
						stats: { home: 3, mentions: 1, dms: 4, needsReply: 2, inbox: 3 },
						transport: { statusText: "local" },
						accounts: [],
						archives: [],
					}),
				);
			}
			if (url.includes("/api/query")) {
				queryUrls.push(new URL(url));
				return new Response(
					JSON.stringify({
						resource: "home",
						items: [{ id: "liked_1", text: "good thing" }],
					}),
				);
			}
			throw new Error(`Unexpected fetch ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(
			<SavedTimelineView
				eyebrow="liked posts"
				filter="liked"
				loadingLabel="Loading liked posts..."
				searchPlaceholder="Search likes"
				title="Liked"
			/>,
		);

		expect(await screen.findByText("good thing")).toBeInTheDocument();
		const queryUrl = queryUrls[0];
		expect(queryUrl?.searchParams.get("liked")).toBe("true");
		expect(queryUrl?.searchParams.get("bookmarked")).toBeNull();
	});

	it("loads bookmarks through the query API", async () => {
		const queryUrls: URL[] = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/status")) {
				return new Response(
					JSON.stringify({
						stats: { home: 3, mentions: 1, dms: 4, needsReply: 2, inbox: 3 },
						transport: { statusText: "local" },
						bookmarkSyncMode: "automatic",
						accounts: [],
						archives: [],
					}),
				);
			}
			if (url.includes("/api/query")) {
				queryUrls.push(new URL(url));
				return new Response(
					JSON.stringify({
						resource: "home",
						items: [{ id: "bookmark_1", text: "saved thing" }],
					}),
				);
			}
			throw new Error(`Unexpected fetch ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(
			<SavedTimelineView
				eyebrow="bookmarks"
				filter="bookmarked"
				loadingLabel="Loading bookmarks..."
				searchPlaceholder="Search bookmarks"
				title="Bookmarks"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText("saved thing")).toBeInTheDocument();
		});
		const queryUrl = queryUrls[0];
		expect(queryUrl?.searchParams.get("bookmarked")).toBe("true");
		expect(queryUrl?.searchParams.get("liked")).toBeNull();
		expect(
			screen.getByRole("status", { name: "Bookmarks sync automatically" }),
		).toHaveTextContent("Auto sync");
		expect(
			screen.queryByRole("button", { name: "Sync bookmarks" }),
		).not.toBeInTheDocument();
	});

	it("labels the local-only fallback as an X collection instead of cloud sync", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.endsWith("/api/status")) {
					return new Response(
						JSON.stringify({
							stats: {
								home: 0,
								mentions: 0,
								dms: 0,
								needsReply: 0,
								inbox: 0,
							},
							transport: { statusText: "local" },
							bookmarkSyncMode: "manual",
							accounts: [],
							archives: [],
						}),
					);
				}
				if (url.includes("/api/query")) {
					return new Response(JSON.stringify({ resource: "home", items: [] }));
				}
				throw new Error(`Unexpected fetch ${url}`);
			}),
		);

		render(
			<SavedTimelineView
				eyebrow="bookmarks"
				filter="bookmarked"
				loadingLabel="Loading bookmarks..."
				searchPlaceholder="Search bookmarks"
				title="Bookmarks"
			/>,
		);

		expect(
			await screen.findByRole("button", { name: "Sync from X" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("status", { name: "Bookmarks sync automatically" }),
		).not.toBeInTheDocument();
		expect(
			screen.getByText(
				"Use Sync from X to collect bookmarks into this local view.",
			),
		).toBeInTheDocument();
	});

	it("refreshes bookmarks automatically without posting a sync command", async () => {
		vi.useFakeTimers();
		try {
			const queryUrls: URL[] = [];
			const syncBodies: unknown[] = [];
			const fetchMock = vi.fn(
				async (input: RequestInfo | URL, init?: RequestInit) => {
					const url = String(input);
					if (url.endsWith("/api/status")) {
						return new Response(
							JSON.stringify({
								stats: {
									home: 3,
									mentions: 1,
									dms: 4,
									needsReply: 2,
									inbox: 3,
								},
								transport: { statusText: "local" },
								bookmarkSyncMode: "automatic",
								accounts: [],
								archives: [],
							}),
						);
					}
					if (url.includes("/api/query")) {
						queryUrls.push(new URL(url));
						return new Response(
							JSON.stringify({
								resource: "home",
								items: [{ id: "bookmark_auto", text: "automatic bookmark" }],
							}),
						);
					}
					if (url.endsWith("/api/sync") && init?.body) {
						syncBodies.push(JSON.parse(String(init.body)));
					}
					throw new Error(`Unexpected fetch ${url}`);
				},
			);
			vi.stubGlobal("fetch", fetchMock);

			render(
				<SavedTimelineView
					eyebrow="bookmarks"
					filter="bookmarked"
					loadingLabel="Loading bookmarks..."
					searchPlaceholder="Search bookmarks"
					title="Bookmarks"
				/>,
			);

			await vi.waitFor(() => {
				expect(screen.getByText("automatic bookmark")).toBeInTheDocument();
			});
			const initialQueryCount = queryUrls.length;
			window.dispatchEvent(new Event("visibilitychange"));
			await vi.waitFor(() => {
				expect(queryUrls.length).toBeGreaterThan(initialQueryCount);
			});
			const focusedQueryCount = queryUrls.length;

			await vi.advanceTimersByTimeAsync(30_000);
			await vi.waitFor(() => {
				expect(queryUrls.length).toBeGreaterThan(focusedQueryCount);
			});
			expect(syncBodies).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("shows item count before status metadata arrives and trims search params", async () => {
		const queryUrls: URL[] = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/status")) {
				return new Promise<Response>(() => {});
			}
			if (url.includes("/api/query")) {
				queryUrls.push(new URL(url));
				return new Response(
					JSON.stringify({
						resource: "home",
						items: [{ id: "liked_2", text: "searchable thing" }],
					}),
				);
			}
			throw new Error(`Unexpected fetch ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(
			<SavedTimelineView
				eyebrow="liked posts"
				filter="liked"
				loadingLabel="Loading liked posts..."
				searchPlaceholder="Search likes"
				title="Liked"
			/>,
		);

		expect(await screen.findByText("searchable thing")).toBeInTheDocument();
		expect(await screen.findByText("1 visible")).toBeInTheDocument();
		fireEvent.change(screen.getByPlaceholderText("Search likes"), {
			target: { value: "  launch  " },
		});

		await waitFor(() => {
			expect(queryUrls.at(-1)?.searchParams.get("search")).toBe("launch");
		});
	});

	it("syncs the matching saved collection and reloads local data", async () => {
		const queryUrls: URL[] = [];
		const syncBodies: unknown[] = [];
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/api/status")) {
					return new Response(
						JSON.stringify({
							stats: { home: 3, mentions: 1, dms: 4, needsReply: 2, inbox: 3 },
							transport: { statusText: "local" },
							accounts: [],
							archives: [],
						}),
					);
				}
				if (url.includes("/api/query")) {
					queryUrls.push(new URL(url));
					return new Response(
						JSON.stringify({
							resource: "home",
							items: [{ id: "liked_sync", text: "fresh liked thing" }],
						}),
					);
				}
				if (url.endsWith("/api/sync") && init?.body) {
					syncBodies.push(JSON.parse(String(init.body)));
					return new Response(
						JSON.stringify({
							id: "sync_likes_1",
							kind: "likes",
							status: "succeeded",
							startedAt: "2026-05-15T12:00:00.000Z",
							summary: "Synced 4 items",
							inProgress: false,
							result: {
								ok: true,
								kind: "likes",
								summary: "Synced 4 items",
								steps: [],
							},
						}),
					);
				}
				throw new Error(`Unexpected fetch ${url}`);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		render(
			<SavedTimelineView
				eyebrow="liked posts"
				filter="liked"
				loadingLabel="Loading liked posts..."
				searchPlaceholder="Search likes"
				title="Liked"
			/>,
		);

		expect(await screen.findByText("fresh liked thing")).toBeInTheDocument();
		const initialQueryCount = queryUrls.length;
		fireEvent.click(screen.getByRole("button", { name: "Sync likes" }));

		await waitFor(() => {
			expect(syncBodies).toEqual([{ kind: "likes" }]);
			expect(queryUrls.length).toBeGreaterThan(initialQueryCount);
		});
	});

	it("ignores empty replies and refreshes after sending a reply", async () => {
		const actionBodies: unknown[] = [];
		const queryUrls: URL[] = [];
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/api/status")) {
					return new Response(
						JSON.stringify({
							stats: { home: 3, mentions: 1, dms: 4, needsReply: 2, inbox: 3 },
							transport: { statusText: "local" },
							accounts: [],
							archives: [],
						}),
					);
				}
				if (url.includes("/api/query")) {
					queryUrls.push(new URL(url));
					return new Response(
						JSON.stringify({
							resource: "home",
							items: [{ id: "bookmark_2", text: "reply target" }],
						}),
					);
				}
				if (url.endsWith("/api/action") && init?.body) {
					actionBodies.push(JSON.parse(String(init.body)));
					return new Response(JSON.stringify({ ok: true }));
				}
				throw new Error(`Unexpected fetch ${url}`);
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		const promptSpy = vi
			.spyOn(window, "prompt")
			.mockReturnValueOnce("  ")
			.mockReturnValueOnce("Thanks");

		render(
			<SavedTimelineView
				eyebrow="bookmarks"
				filter="bookmarked"
				loadingLabel="Loading bookmarks..."
				searchPlaceholder="Search bookmarks"
				title="Bookmarks"
			/>,
		);

		expect(await screen.findByText("reply target")).toBeInTheDocument();
		const initialQueryCount = queryUrls.length;
		fireEvent.click(screen.getByRole("button", { name: "reply bookmark_2" }));
		expect(actionBodies).toEqual([]);

		fireEvent.click(screen.getByRole("button", { name: "reply bookmark_2" }));

		await waitFor(() => {
			expect(actionBodies).toEqual([
				expect.objectContaining({ tweetId: "bookmark_2", text: "Thanks" }),
			]);
			expect(queryUrls.length).toBeGreaterThan(initialQueryCount);
		});
		expect(promptSpy).toHaveBeenCalledTimes(2);
	});

	it("shows a retryable error when saved posts fail to load", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/status")) {
				return new Response(
					JSON.stringify({
						stats: { home: 3, mentions: 1, dms: 4, needsReply: 2, inbox: 3 },
						transport: { statusText: "local" },
						accounts: [],
						archives: [],
					}),
				);
			}
			if (url.includes("/api/query")) {
				throw new Error("Saved store unavailable");
			}
			throw new Error(`Unexpected fetch ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(
			<SavedTimelineView
				eyebrow="bookmarks"
				filter="bookmarked"
				loadingLabel="Loading bookmarks..."
				searchPlaceholder="Search bookmarks"
				title="Bookmarks"
			/>,
		);

		expect(
			await screen.findByText("Could not load bookmarks"),
		).toBeInTheDocument();
		expect(screen.getByText("Saved store unavailable")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(3);
		});
	});
});
