import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithQueryClient as render } from "#/test/render";

vi.mock("#/components/TimelineCard", () => ({
	TimelineCard: ({ item }: { item: { id: string; text: string } }) => (
		<article data-testid={`card-${item.id}`}>{item.text}</article>
	),
}));

vi.mock("#/components/SyncNowButton", () => ({
	SyncNowButton: ({ onSynced }: { onSynced?: () => void }) => (
		<button onClick={onSynced} type="button">
			同步 Home
		</button>
	),
}));

import { SpecialFollowTimeline } from "./SpecialFollowTimeline";

function status() {
	return Response.json({
		stats: { home: 3, mentions: 1, dms: 0, needsReply: 0, inbox: 1 },
		transport: {
			installed: true,
			availableTransport: "local",
			statusText: "cloud",
		},
		accounts: [
			{
				id: "acct_primary",
				name: "Primary",
				handle: "owner",
				transport: "local",
				isDefault: 1,
				createdAt: "2026-08-13T00:00:00.000Z",
			},
		],
		archives: [],
	});
}

function item(id: string, text: string, createdAt: string) {
	return {
		id,
		accountId: "acct_primary",
		accountHandle: "owner",
		kind: "home",
		text,
		createdAt,
		isReplied: false,
		likeCount: 0,
		mediaCount: 0,
		bookmarked: false,
		liked: false,
		author: {
			id: "profile_user_42",
			handle: "ada",
			displayName: "Ada",
			bio: "",
			followersCount: 10,
			avatarHue: 20,
			createdAt: "2026-08-01T00:00:00.000Z",
		},
		entities: {},
		media: [],
	};
}

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	window.localStorage.clear();
});

describe("SpecialFollowTimeline", () => {
	it("restores a cloud anchor without jumping to the newest item", async () => {
		const scrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
		const feedModes: Array<string | null> = [];
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, _init?: RequestInit) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/status") return status();
				if (url.pathname === "/api/special-follow-position") {
					return Response.json({
						accountId: "acct_primary",
						viewKey: "special-follow",
						position: {
							anchorTweetId: "anchor",
							anchorCreatedAt: "2026-08-12T00:00:00.000Z",
							pixelOffset: 36,
							clientSessionId: "device-a",
							clientSequence: 2,
							revision: 4,
							updatedAt: "2026-08-13T00:00:00.000Z",
						},
					});
				}
				if (url.pathname === "/api/special-follow-feed") {
					feedModes.push(url.searchParams.get("mode"));
					return Response.json({
						items: [
							item("newer", "newer post", "2026-08-13T00:00:00.000Z"),
							item("anchor", "saved post", "2026-08-12T00:00:00.000Z"),
						],
						specialFollowProfileCount: 1,
						page: {
							mode: "resume",
							hasNewer: true,
							hasOlder: false,
							newerCursor: {
								createdAt: "2026-08-13T00:00:00.000Z",
								tweetId: "newer",
							},
							olderCursor: {
								createdAt: "2026-08-12T00:00:00.000Z",
								tweetId: "anchor",
							},
							restore: {
								requestedTweetId: "anchor",
								resolvedTweetId: "anchor",
								createdAt: "2026-08-12T00:00:00.000Z",
								pixelOffset: 36,
								exact: true,
							},
						},
					});
				}
				throw new Error(`Unexpected fetch ${url.pathname}`);
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		const rect = vi
			.spyOn(HTMLElement.prototype, "getBoundingClientRect")
			.mockImplementation(function (this: HTMLElement) {
				const isAnchor = this.dataset.specialFollowAnchor === "anchor";
				const top = isAnchor ? 420 : 0;
				return {
					x: 0,
					y: top,
					top,
					left: 0,
					right: 680,
					bottom: top + 240,
					width: 680,
					height: 240,
					toJSON: () => ({}),
				};
			});

		render(<SpecialFollowTimeline viewTabs={<div>views</div>} />);

		expect(await screen.findByText("saved post")).toBeInTheDocument();
		expect(screen.getByText("newer post")).toBeInTheDocument();
		expect(feedModes).toEqual(["resume"]);
		expect(
			screen.getByRole("button", { name: "上方还有新动态 · 查看最新" }),
		).toBeInTheDocument();
		await waitFor(() => expect(scrollBy).toHaveBeenCalledTimes(1));
		expect(rect).toHaveBeenCalled();
		const patches = fetchMock.mock.calls.filter(
			([, init]) => init?.method === "PATCH",
		);
		expect(patches).toHaveLength(0);
	});

	it("distinguishes an unconfigured feed and links to real author selection", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/status") return status();
				if (url.pathname === "/api/special-follow-position") {
					return Response.json({
						accountId: "acct_primary",
						viewKey: "special-follow",
						position: null,
					});
				}
				if (url.pathname === "/api/special-follow-feed") {
					return Response.json({
						items: [],
						specialFollowProfileCount: 0,
						page: {
							mode: "resume",
							hasNewer: false,
							hasOlder: false,
							newerCursor: null,
							olderCursor: null,
							restore: null,
						},
					});
				}
				throw new Error(`Unexpected fetch ${url.pathname}`);
			}),
		);

		render(<SpecialFollowTimeline viewTabs={<div>views</div>} />);

		expect(await screen.findByText("还没有特别关注")).toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: "去 Home 选择作者" }),
		).toHaveAttribute("href", "/");
		fireEvent.click(screen.getByRole("button", { name: "同步 Home" }));
	});

	it("persists only after a real reading interaction, with a bounded cadence", async () => {
		const patchBodies: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/status") return status();
				if (url.pathname === "/api/special-follow-position") {
					if (init?.method === "PATCH") {
						const body = JSON.parse(String(init.body)) as Record<
							string,
							unknown
						>;
						patchBodies.push(body);
						return Response.json({
							ok: true,
							applied: true,
							accountId: "acct_primary",
							viewKey: "special-follow",
							position: {
								anchorTweetId: body.anchorTweetId,
								anchorCreatedAt: "2026-08-12T00:00:00.000Z",
								pixelOffset: body.pixelOffset,
								clientSessionId: body.clientSessionId,
								clientSequence: body.clientSequence,
								revision: 1,
								updatedAt: "2026-08-13T00:00:00.000Z",
							},
						});
					}
					return Response.json({
						accountId: "acct_primary",
						viewKey: "special-follow",
						position: null,
					});
				}
				if (url.pathname === "/api/special-follow-feed") {
					return Response.json({
						items: [item("anchor", "reading post", "2026-08-12T00:00:00.000Z")],
						specialFollowProfileCount: 1,
						page: {
							mode: "resume",
							hasNewer: false,
							hasOlder: false,
							newerCursor: null,
							olderCursor: null,
							restore: null,
						},
					});
				}
				throw new Error(`Unexpected fetch ${url.pathname}`);
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
			function (this: HTMLElement) {
				const isCard = Boolean(this.dataset.specialFollowAnchor);
				const top = isCard ? 100 : 0;
				const bottom = isCard ? 400 : 64;
				return {
					x: 0,
					y: top,
					top,
					left: 0,
					right: 680,
					bottom,
					width: 680,
					height: bottom - top,
					toJSON: () => ({}),
				};
			},
		);

		render(<SpecialFollowTimeline viewTabs={<div>views</div>} />);
		expect(await screen.findByText("reading post")).toBeInTheDocument();
		expect(patchBodies).toHaveLength(0);

		fireEvent.wheel(window);
		fireEvent.scroll(window);

		await waitFor(() => expect(patchBodies).toHaveLength(1), {
			timeout: 4_000,
		});
		expect(patchBodies[0]).toMatchObject({
			accountId: "acct_primary",
			anchorTweetId: "anchor",
			pixelOffset: 36,
			expectedRevision: 0,
		});
	});

	it("restores the saved anchor again after a Home sync refresh", async () => {
		const scrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
		const patchBodies: Array<Record<string, unknown>> = [];
		let feedReads = 0;
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/status") return status();
				if (url.pathname === "/api/special-follow-position") {
					if (init?.method === "PATCH") {
						const body = JSON.parse(String(init.body)) as Record<
							string,
							unknown
						>;
						patchBodies.push(body);
						return Response.json({
							ok: true,
							applied: true,
							accountId: "acct_primary",
							viewKey: "special-follow",
							position: {
								anchorTweetId: "anchor",
								anchorCreatedAt: "2026-08-12T00:00:00.000Z",
								pixelOffset: body.pixelOffset,
								clientSessionId: body.clientSessionId,
								clientSequence: body.clientSequence,
								revision: 2,
								updatedAt: "2026-08-13T00:00:00.000Z",
							},
						});
					}
					return Response.json({
						accountId: "acct_primary",
						viewKey: "special-follow",
						position: {
							anchorTweetId: "anchor",
							anchorCreatedAt: "2026-08-12T00:00:00.000Z",
							pixelOffset: 36,
							clientSessionId: "device-a",
							clientSequence: 1,
							revision: 1,
							updatedAt: "2026-08-13T00:00:00.000Z",
						},
					});
				}
				if (url.pathname === "/api/special-follow-feed") {
					feedReads += 1;
					return Response.json({
						items: [item("anchor", "saved post", "2026-08-12T00:00:00.000Z")],
						specialFollowProfileCount: 1,
						page: {
							mode: "resume",
							hasNewer: feedReads > 1,
							hasOlder: false,
							newerCursor: null,
							olderCursor: null,
							restore: {
								requestedTweetId: "anchor",
								resolvedTweetId: "anchor",
								createdAt: "2026-08-12T00:00:00.000Z",
								pixelOffset: 36,
								exact: true,
							},
						},
					});
				}
				throw new Error(`Unexpected fetch ${url.pathname}`);
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
			function (this: HTMLElement) {
				const top = this.dataset.specialFollowAnchor === "anchor" ? 420 : 0;
				return {
					x: 0,
					y: top,
					top,
					left: 0,
					right: 680,
					bottom: top + 240,
					width: 680,
					height: 240,
					toJSON: () => ({}),
				};
			},
		);

		render(<SpecialFollowTimeline viewTabs={<div>views</div>} />);
		expect(await screen.findByText("saved post")).toBeInTheDocument();
		await waitFor(() => expect(scrollBy).toHaveBeenCalledTimes(1));
		fireEvent.wheel(window);
		fireEvent.scroll(window);
		await waitFor(() => expect(patchBodies).toHaveLength(1), {
			timeout: 4_000,
		});

		fireEvent.click(screen.getByRole("button", { name: "同步 Home" }));
		await waitFor(() => expect(feedReads).toBe(2));
		await waitFor(() => expect(scrollBy).toHaveBeenCalledTimes(2));
	});
});
