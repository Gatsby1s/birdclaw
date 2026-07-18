import {
	act,
	cleanup,
	fireEvent,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ndjsonResponse } from "#/test/ndjson";
import { renderWithQueryClient as render } from "#/test/render";
import { TodayRouteView as TodayRoute } from "./today";

const authorProfile = {
	id: "profile_alice",
	handle: "alice",
	displayName: "Alice",
	bio: "Builds useful things.",
	followersCount: 1200,
	followingCount: 200,
	avatarHue: 42,
	createdAt: "2020-01-01T00:00:00.000Z",
};

const hydratedAuthorProfile = {
	...authorProfile,
	displayName: "Alice Fresh",
	avatarUrl: "https://pbs.twimg.com/profile_images/alice/avatar.jpg",
};

function digestResult(label: string, markdown: string, includeDms = false) {
	return {
		context: {
			window: {
				label,
				since: "2026-05-16T00:00:00.000Z",
				until: "2026-05-16T12:00:00.000Z",
			},
			includeDms,
			counts: {
				home: 3,
				mentions: 2,
				authored: 1,
				likes: 1,
				bookmarks: 1,
				dms: includeDms ? 1 : 0,
				links: 4,
			},
			tweets: [
				{
					id: "tweet_1",
					url: "https://x.com/alice/status/tweet_1",
					source: "mentions",
					author: "alice",
					name: "Alice",
					authorProfile,
					createdAt: "2026-05-16T10:00:00.000Z",
					text: "Peter should see this.",
					entities: {
						urls: [
							{
								url: "https://t.co/original",
								expandedUrl: "https://x.com/alice/status/tweet_1",
								displayUrl: "x.com/alice/status/tweet_1",
								start: 0,
								end: 0,
							},
							{
								url: "https://t.co/reference",
								expandedUrl: "https://example.com/reference",
								displayUrl: "example.com/reference",
								start: 0,
								end: 0,
							},
						],
					},
					likeCount: 12,
					liked: false,
					bookmarked: false,
					needsReply: true,
				},
			],
			dms: [],
			links: [],
			hash: label,
		},
		digest: {
			title: label,
			summary: `${label} summary`,
			keyTopics: [
				{
					title: "Useful signal",
					summary: "Alice shared something worth a reply.",
					tweetIds: ["tweet_1"],
					handles: ["@alice"],
				},
			],
			notableLinks: [
				{
					title: "Example",
					url: "https://example.com",
					why: "Worth reading.",
					sourceTweetIds: ["tweet_1"],
				},
				{
					title: "Unsafe",
					url: "javascript:alert(1)",
					why: "Should render as inert text.",
					sourceTweetIds: ["tweet_1"],
				},
			],
			people: [
				{ handle: "alice", name: "Alice", why: "Shared useful signal." },
			],
			actionItems: [
				{ kind: "reply", label: "Reply to Alice", tweetId: "tweet_1" },
			],
			sourceTweetIds: ["tweet_1"],
		},
		markdown,
		model: "gpt-5.5",
		reasoningEffort: "medium",
		serviceTier: "priority",
		cached: false,
		updatedAt: "2026-05-16T12:00:00.000Z",
	};
}

describe("today route", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("streams a digest and reloads when controls change", async () => {
		const urls: URL[] = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input));
			urls.push(url);
			if (url.pathname === "/api/profile-hydrate") {
				return new Response(
					JSON.stringify({
						ok: true,
						results: [
							{
								handle: "alice",
								status: "hit",
								source: "bird",
								profile: hydratedAuthorProfile,
							},
						],
					}),
					{ headers: { "content-type": "application/json" } },
				);
			}
			const period = url.searchParams.get("period") ?? "today";
			const includeDms = url.searchParams.get("includeDms") === "true";
			const label = period === "week" ? "Last 7 days" : "Today";
			const markdown = includeDms
				? "# With DMs\n\n## What people are talking about\n\n- Ask @alice about tweet_1"
				: `# ${label}\n\n## What people are talking about\n\n- Ask @alice about tweet_1`;
			return ndjsonResponse([
				{ type: "delta", delta: `${markdown}\n` },
				{ type: "done", result: digestResult(label, markdown, includeDms) },
			]);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<TodayRoute />);

		expect(
			await screen.findByRole("heading", { name: "Today", level: 1 }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("heading", {
				name: "What people are talking about",
				level: 2,
			}),
		).toBeInTheDocument();
		expect(screen.queryByText("Today summary")).toBeNull();
		expect(screen.queryByRole("heading", { name: "Key topics" })).toBeNull();
		const topicHeading = screen.getByRole("heading", {
			name: "Useful signal",
			level: 3,
		});
		expect(topicHeading).toBeInTheDocument();
		expect(
			screen.queryByText("Alice shared something worth a reply."),
		).toBeNull();
		expect(screen.queryByText(/Action items/i)).toBeNull();
		expect(screen.queryByText("# Today")).not.toBeInTheDocument();
		const aliceLink = screen.getByRole("link", { name: "@alice" });
		expect(
			topicHeading.compareDocumentPosition(aliceLink) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(aliceLink).toHaveAttribute("href", "/profiles/alice");
		expect(screen.getByRole("link", { name: "tweet_1" })).toHaveAttribute(
			"href",
			"https://x.com/alice/status/tweet_1",
		);
		expect(
			screen.getByText("3 home · 2 mentions · 4 links"),
		).toBeInTheDocument();
		const todayButton = screen.getByRole("button", { name: "Today" });
		expect(todayButton).toHaveClass("!bg-[var(--accent)]");
		expect(todayButton).toHaveClass("!text-[var(--accent-text)]");
		await waitFor(() =>
			expect(urls.some((url) => url.pathname === "/api/profile-hydrate")).toBe(
				true,
			),
		);
		fireEvent.pointerEnter(aliceLink.parentElement as Element);
		await screen.findByText("Alice Fresh");
		expect(screen.getByRole("img", { name: "Alice Fresh" })).toHaveAttribute(
			"src",
			expect.stringContaining("/api/avatar?profileId=profile_alice&v="),
		);

		fireEvent.click(screen.getByRole("button", { name: "Week" }));
		expect(
			await screen.findByRole("heading", { name: "Last 7 days", level: 1 }),
		).toBeInTheDocument();

		fireEvent.click(screen.getByLabelText("DMs"));
		expect(
			await screen.findByRole("heading", { name: "With DMs", level: 1 }),
		).toBeInTheDocument();
		expect(
			screen.getByText("3 home · 2 mentions · 4 links · 1 DMs"),
		).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
		await waitFor(() =>
			expect(
				urls.some((url) => url.searchParams.get("refresh") === "true"),
			).toBe(true),
		);
		expect(
			urls.some(
				(url) =>
					url.searchParams.get("period") === "week" &&
					url.searchParams.get("includeDms") === "true" &&
					url.searchParams.get("liveSync") === "false",
			),
		).toBe(true);
	});

	it("keeps structured topic headings when the model markdown is flat", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input));
				if (url.pathname === "/api/profile-hydrate") {
					return new Response(JSON.stringify({ ok: true, results: [] }), {
						headers: { "content-type": "application/json" },
					});
				}
				const markdown =
					"**What people are talking about**\n\n- Alice shared a useful signal (tweet_1).";
				return ndjsonResponse([
					{ type: "delta", delta: markdown },
					{ type: "done", result: digestResult("Today", markdown) },
				]);
			}),
		);

		render(<TodayRoute />);

		expect(
			await screen.findByRole("heading", {
				name: "Useful signal",
				level: 3,
			}),
		).toBeInTheDocument();
		expect(
			screen.queryByText("Alice shared something worth a reply."),
		).toBeNull();
	});

	it("places every structured topic before its matching discussion bullet", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input));
				if (url.pathname === "/api/profile-hydrate") {
					return new Response(JSON.stringify({ ok: true, results: [] }), {
						headers: { "content-type": "application/json" },
					});
				}
				const markdown = [
					"## What people are talking about",
					"",
					...Array.from(
						{ length: 6 },
						(_, index) =>
							`- Discussion ${String(index + 1)} (tweet_${String(index + 1)}).`,
					),
				].join("\n\n");
				const result = digestResult("Today", markdown);
				result.digest.keyTopics = Array.from({ length: 6 }, (_, index) => ({
					title: `Topic ${String(index + 1)}`,
					summary: `Summary ${String(index + 1)}`,
					tweetIds: [`tweet_${String(index + 1)}`],
					handles: ["@alice"],
				}));
				return ndjsonResponse([
					{ type: "delta", delta: markdown },
					{ type: "done", result },
				]);
			}),
		);

		render(<TodayRoute />);

		expect(
			await screen.findByRole("heading", { name: "Topic 1", level: 3 }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { name: "Topic 6", level: 3 }),
		).toBeInTheDocument();
		expect(screen.queryByRole("heading", { name: "Key topics" })).toBeNull();
	});

	it("does not duplicate a topic heading already present in the report", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input));
				if (url.pathname === "/api/profile-hydrate") {
					return new Response(JSON.stringify({ ok: true, results: [] }), {
						headers: { "content-type": "application/json" },
					});
				}
				const markdown =
					"## What people are talking about\n\n### Useful signal\n\n- Alice shared a useful signal (tweet_1).";
				return ndjsonResponse([
					{ type: "delta", delta: markdown },
					{ type: "done", result: digestResult("Today", markdown) },
				]);
			}),
		);

		render(<TodayRoute />);

		expect(
			await screen.findAllByRole("heading", {
				name: "Useful signal",
				level: 3,
			}),
		).toHaveLength(1);
	});

	it("exports a completed digest through the browser PDF flow", async () => {
		document.title = "birdclaw";
		const printMock = vi.spyOn(window, "print").mockImplementation(() => {
			expect(document.title).toBe("BirdClaw Today digest");
			window.dispatchEvent(new Event("afterprint"));
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input));
				if (url.pathname === "/api/profile-hydrate") {
					return new Response(JSON.stringify({ ok: true, results: [] }), {
						headers: { "content-type": "application/json" },
					});
				}
				const markdown = "# Today\n\nDone.";
				return ndjsonResponse([
					{ type: "delta", delta: markdown },
					{ type: "done", result: digestResult("Today", markdown) },
				]);
			}),
		);

		render(<TodayRoute />);

		await screen.findByRole("heading", { name: "Today", level: 1 });
		const exportButton = screen.getByRole("button", { name: "Export PDF" });
		expect(exportButton).toBeEnabled();

		fireEvent.click(exportButton);

		expect(printMock).toHaveBeenCalledTimes(1);
		expect(document.title).toBe("birdclaw");
	});

	it("exports the cached digest context as a reference collection without rerunning the digest", async () => {
		document.title = "birdclaw";
		const digestRequests: URL[] = [];
		const printMock = vi.spyOn(window, "print").mockImplementation(() => {
			try {
				expect(document.title).toBe("BirdClaw Today reference collection");
				expect(document.body.dataset.todayPrintMode).toBe("reference");
				const referencePdf = screen.getByTestId("today-reference-pdf");
				const referenceText = referencePdf.textContent ?? "";
				expect(
					within(referencePdf).getByRole("heading", {
						name: "BirdClaw Today 参考内容合集",
						level: 1,
					}),
				).toBeInTheDocument();
				expect(
					within(referencePdf).getByText(
						"Opening summary shown on the webpage.",
					),
				).toBeInTheDocument();
				expect(
					within(referencePdf).queryByText(
						"Structured summary must not replace the webpage.",
					),
				).toBeNull();
				expect(
					within(referencePdf).getAllByText("Useful signal"),
				).not.toHaveLength(0);
				expect(
					within(referencePdf).getByRole("heading", {
						name: "热议主题",
						level: 2,
					}),
				).toBeInTheDocument();
				expect(
					within(referencePdf).getByText(
						/Markdown summary starts here and continues exactly as shown\./,
					),
				).toBeInTheDocument();
				expect(
					within(referencePdf).getByText(
						/A second paragraph remains under the same webpage topic\./,
					),
				).toBeInTheDocument();
				expect(referenceText).toContain(
					"An uncited webpage paragraph remains in the collection.",
				);
				expect(referenceText).toContain(
					"This deliberately long topic heading stays complete in the printed table of contents without being shortened",
				);
				expect(
					within(referencePdf).queryByText(
						"Alice shared something worth a reply.",
					),
				).toBeNull();
				expect(within(referencePdf).getAllByText("S01")).not.toHaveLength(0);
				expect(
					within(referencePdf).getAllByText("Alice (@alice)"),
				).not.toHaveLength(0);
				expect(
					within(referencePdf).getByRole("heading", {
						name: "来源矩阵",
						level: 2,
					}),
				).toBeInTheDocument();
				expect(
					within(referencePdf).getByRole("heading", {
						name: "来源索引",
						level: 2,
					}),
				).toBeInTheDocument();
				expect(
					within(referencePdf).getAllByRole("columnheader", {
						name: "来源编号",
					}),
				).not.toHaveLength(0);
				expect(
					within(referencePdf).getAllByRole("columnheader", {
						name: "作者 / 账号 ID",
					}),
				).not.toHaveLength(0);
				expect(
					within(referencePdf).getByRole("link", { name: "S01 所在页" }),
				).toHaveAttribute("href", "#reference-source-S01");
				expect(within(referencePdf).getByText("tweet_1")).toBeInTheDocument();
				expect(
					within(referencePdf).getAllByText("2026-05-16"),
				).not.toHaveLength(0);
				expect(within(referencePdf).queryByText(/12 likes|12 赞/)).toBeNull();
				expect(
					within(referencePdf).queryByText(
						"https://x.com/alice/status/tweet_1",
					),
				).toBeNull();
				expect(
					within(referencePdf).queryByText("x.com/alice/status/tweet_1"),
				).toBeNull();
				expect(
					within(referencePdf).queryByText(/example\.com\/reference/),
				).toBeNull();
				expect(referenceText).not.toMatch(
					/\b(Home|Mention|Authored|Liked|Bookmark)\b/,
				);
				expect(referenceText).not.toContain("3 home · 2 mentions · 4 links");
				expect(referenceText).not.toContain("8:00 PM");
			} finally {
				window.dispatchEvent(new Event("afterprint"));
			}
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input));
				if (url.pathname === "/api/profile-hydrate") {
					return new Response(JSON.stringify({ ok: true, results: [] }), {
						headers: { "content-type": "application/json" },
					});
				}
				digestRequests.push(url);
				const markdown = [
					"# Today",
					"",
					"Opening summary shown on the webpage.",
					"",
					"**大家在聊什么**",
					"",
					"### Useful signal",
					"",
					"- An uncited webpage paragraph remains in the collection.",
					"- Markdown summary starts here",
					"  and continues exactly as shown.",
					"  (tweet_1)",
					"- A second paragraph remains under the same webpage topic. (tweet_1)",
					"",
					"### This deliberately long topic heading stays complete in the printed table of contents without being shortened",
					"",
					"- The full heading is part of the webpage content. (tweet_1)",
				].join("\n");
				const result = digestResult("Today", markdown);
				result.digest.summary =
					"Structured summary must not replace the webpage.";
				return ndjsonResponse([
					{ type: "delta", delta: markdown },
					{ type: "done", result },
				]);
			}),
		);

		render(<TodayRoute />);

		await screen.findByRole("heading", { name: "Today", level: 1 });
		expect(digestRequests).toHaveLength(1);
		const referenceButton = screen.getByRole("button", {
			name: "导出完整 PDF",
		});
		expect(referenceButton).toBeEnabled();

		fireEvent.click(referenceButton);

		expect(printMock).toHaveBeenCalledTimes(1);
		expect(digestRequests).toHaveLength(1);
		expect(document.title).toBe("birdclaw");
		expect(document.body.dataset.todayPrintMode).toBeUndefined();
	});

	it("renders generated citations as source links without coloring the prose", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input));
				if (url.pathname === "/api/profile-hydrate") {
					return new Response(JSON.stringify({ ok: true, results: [] }), {
						headers: { "content-type": "application/json" },
					});
				}
				const markdown =
					"# Today\n\n## What people are talking about\n\n- Alice says memory pricing should stay firm (tweet_1).";
				return ndjsonResponse([
					{ type: "delta", delta: markdown },
					{ type: "done", result: digestResult("Today", markdown) },
				]);
			}),
		);

		render(<TodayRoute />);

		await screen.findByRole("heading", { name: "Today", level: 1 });
		expect(
			screen.queryByRole("link", {
				name: "Alice says memory pricing should stay firm",
			}),
		).toBeNull();
		expect(
			screen.getByText(/Alice says memory pricing should stay firm/),
		).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "source" })).toHaveAttribute(
			"href",
			"https://x.com/alice/status/tweet_1",
		);
		expect(screen.queryByText(/tweet_1/)).toBeNull();
	});

	it("renders generated markdown title links without the accent color", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input));
				if (url.pathname === "/api/profile-hydrate") {
					return new Response(JSON.stringify({ ok: true, results: [] }), {
						headers: { "content-type": "application/json" },
					});
				}
				const markdown =
					"# Today\n\n## Important links shared\n\n- [bboczeng 的存储周期长文](https://x.com/bboczeng/status/2071506694723736039)：围绕美光财报、苹果涨价、存储上涨可持续性展开。";
				return ndjsonResponse([
					{ type: "delta", delta: markdown },
					{ type: "done", result: digestResult("Today", markdown) },
				]);
			}),
		);

		render(<TodayRoute />);

		await screen.findByRole("heading", { name: "Today", level: 1 });
		const titleLink = screen.getByRole("link", {
			name: "bboczeng 的存储周期长文",
		});
		expect(titleLink).toHaveAttribute(
			"href",
			"https://x.com/bboczeng/status/2071506694723736039",
		);
		expect(titleLink).toHaveClass("text-[var(--ink)]");
		expect(titleLink).not.toHaveClass("text-[var(--accent)]");
	});

	it("shows request errors", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							ok: false,
							message:
								"Remote API access requires BIRDCLAW_ALLOW_REMOTE_WEB=1 for a trusted private proxy, or BIRDCLAW_WEB_TOKEN for tokened access",
						}),
						{
							headers: { "content-type": "application/json" },
							status: 403,
						},
					),
			),
		);

		render(<TodayRoute />);

		expect(
			await screen.findByText(
				"Digest request failed (403): Remote API access requires BIRDCLAW_ALLOW_REMOTE_WEB=1 for a trusted private proxy, or BIRDCLAW_WEB_TOKEN for tokened access",
			),
		).toBeInTheDocument();
	});

	it("shows an actionable message when the digest connection drops", async () => {
		const fetchMock = vi.fn(async () => {
			throw new TypeError("network error");
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<TodayRoute />);

		expect(
			await screen.findByText(
				"Digest connection was interrupted while starting digest. Retry to continue.",
			),
		).toBeInTheDocument();
		expect(screen.getByText("Digest failed")).toBeInTheDocument();
		expect(
			screen.getByText("No digest was generated. Retry to start a new run."),
		).toBeInTheDocument();
		expect(
			screen.queryByText("Waiting for the first tokens..."),
		).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
	});

	it("shows fetch status before the first markdown token", async () => {
		let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
		const encoder = new TextEncoder();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input));
				if (url.pathname === "/api/profile-hydrate") {
					return new Response(JSON.stringify({ ok: true, results: [] }), {
						headers: { "content-type": "application/json" },
					});
				}
				return new Response(
					new ReadableStream<Uint8Array>({
						start(streamController) {
							controller = streamController;
							streamController.enqueue(
								encoder.encode(
									`${JSON.stringify({
										type: "status",
										label: "Fetching home timeline from X",
									})}\n`,
								),
							);
						},
					}),
					{ headers: { "content-type": "application/x-ndjson" } },
				);
			}),
		);

		render(<TodayRoute />);

		expect(
			await screen.findAllByText("Fetching home timeline from X"),
		).not.toHaveLength(0);

		const markdown = "# Today\n\nDone.";
		await act(async () => {
			controller?.enqueue(
				encoder.encode(
					[
						JSON.stringify({ type: "delta", delta: markdown }),
						JSON.stringify({
							type: "done",
							result: digestResult("Today", markdown),
						}),
						"",
					].join("\n"),
				),
			);
			controller?.close();
		});

		expect(
			await screen.findByRole("heading", { name: "Today", level: 1 }),
		).toBeInTheDocument();
	});

	it("shows streamed error events", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				ndjsonResponse([{ type: "error", error: "model failed" }]),
			),
		);

		render(<TodayRoute />);

		expect(await screen.findByText("model failed")).toBeInTheDocument();
	});
});
