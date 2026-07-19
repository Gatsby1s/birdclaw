import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateDiscussSearch } from "#/lib/route-search";
import type { TweetMediaItem } from "#/lib/types";
import { ndjsonResponse } from "#/test/ndjson";
import { DiscussRouteView as DiscussRoute } from "./discuss";

function discussionResult(markdown: string) {
	return {
		context: {
			query: "ChatGPT",
			source: "search",
			includeDms: true,
			counts: {
				search: 3,
				home: 1,
				mentions: 1,
				authored: 0,
				likes: 1,
				bookmarks: 0,
				dms: 2,
			},
			tweets: [
				{
					id: "tweet_1",
					url: "https://x.com/alice/status/tweet_1",
					source: "search",
					author: "alice",
					name: "Alice",
					authorProfile: {
						id: "profile_alice",
						handle: "alice",
						displayName: "Alice",
						bio: "Builds useful things.",
						followersCount: 12,
						followingCount: 3,
						avatarHue: 42,
						createdAt: "2026-01-01T00:00:00.000Z",
					},
					createdAt: "2026-05-23T08:18:00.000Z",
					text: "ChatGPT is useful for summaries.",
					media: [] as TweetMediaItem[],
					likeCount: 4,
					liked: false,
					bookmarked: false,
					needsReply: false,
				},
			],
			dms: [],
			liveSearch: {
				ok: true,
				source: "bird",
				accountId: "acct_primary",
				query: "ChatGPT",
				count: 3,
				pageCount: 1,
				tweetIds: ["tweet_1"],
			},
			hash: "hash",
		},
		discussion: {
			title: "ChatGPT",
			summary: "People discuss practical AI workflows.",
			themes: [
				{
					title: "Practical workflows",
					summary: "Summaries stay readable and useful.",
					tweetIds: ["tweet_1"],
					dmConversationIds: [],
					handles: ["alice"],
				},
			],
			tensions: ["Speed and depth still need balancing."],
			followUps: ["Compare the strongest workflows."],
			sourceTweetIds: ["tweet_1"],
			sourceDmConversationIds: [],
		},
		markdown,
		model: "gpt-5.5",
		reasoningEffort: "medium",
		serviceTier: "priority",
		cached: false,
		updatedAt: "2026-05-23T08:20:00.000Z",
	};
}

describe("discuss route", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("streams a keyword discussion and refreshes the submitted query", async () => {
		const urls: URL[] = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input));
			urls.push(url);
			const query = url.searchParams.get("query") ?? "";
			const markdown = `# ${query}\n\n## Themes\n\n- Practical workflows stay readable (tweet_1).\n\n[Related link](https://example.com)`;
			return ndjsonResponse([
				{
					type: "start",
					context: discussionResult(markdown).context,
					cached: false,
				},
				{ type: "delta", delta: markdown },
				{ type: "done", result: discussionResult(markdown) },
			]);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<DiscussRoute />);

		expect(
			screen.getByRole("heading", { name: "Discuss", level: 1 }),
		).toBeInTheDocument();
		expect(screen.getByText("Search to begin.")).toBeInTheDocument();
		expect(screen.getByLabelText("Mode")).toHaveValue("xurl");
		expect(screen.getByRole("button", { name: "All" })).toHaveClass(
			"!bg-[var(--accent)]",
		);

		fireEvent.change(screen.getByPlaceholderText("Keywords"), {
			target: { value: "ChatGPT" },
		});
		fireEvent.change(screen.getByPlaceholderText("Optional question"), {
			target: { value: "Useful takeaways" },
		});
		fireEvent.change(screen.getByLabelText("Mode"), {
			target: { value: "bird" },
		});
		fireEvent.change(screen.getByLabelText("Source"), {
			target: { value: "all" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Yesterday" }));
		fireEvent.click(screen.getByLabelText("DMs"));
		fireEvent.click(screen.getByRole("button", { name: "Discuss" }));

		expect(
			await screen.findByRole("heading", { name: "ChatGPT", level: 1 }),
		).toBeInTheDocument();
		expect(
			screen.getByText(/Practical workflows stay readable/),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("link", { name: /Practical workflows/ }),
		).toBeNull();
		expect(screen.getByRole("link", { name: "source" })).toHaveAttribute(
			"href",
			"https://x.com/alice/status/tweet_1",
		);
		expect(screen.getByRole("link", { name: "Related link" })).toHaveClass(
			"text-[var(--ink)]",
		);
		expect(
			screen.getByText(
				"bird 3 fetched · 3 search · 2 timeline · 1 saved · 2 DMs",
			),
		).toBeInTheDocument();
		expect(urls[0]?.searchParams.get("source")).toBe("all");
		expect(urls[0]?.searchParams.get("mode")).toBe("bird");
		expect(urls[0]?.searchParams.get("includeDms")).toBe("true");
		expect(urls[0]?.searchParams.get("question")).toBe("Useful takeaways");
		expect(urls[0]?.searchParams.get("since")).toBeTruthy();
		expect(urls[0]?.searchParams.get("until")).toBeTruthy();
		expect(
			new Date(urls[0]?.searchParams.get("since") ?? "").getTime(),
		).toBeLessThan(
			new Date(urls[0]?.searchParams.get("until") ?? "").getTime(),
		);
		expect(urls[0]?.searchParams.get("limit")).toBe("20000");
		expect(urls[0]?.searchParams.get("maxPages")).toBe("200");
		expect(urls[0]?.searchParams.has("refresh")).toBe(false);

		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		expect(urls[1]?.searchParams.get("refresh")).toBe("true");
		expect(urls[1]?.searchParams.get("since")).toBe(
			urls[0]?.searchParams.get("since"),
		);
		expect(urls[1]?.searchParams.get("until")).toBe(
			urls[0]?.searchParams.get("until"),
		);

		fireEvent.click(screen.getByRole("button", { name: "All" }));
		expect(fetchMock).toHaveBeenCalledTimes(2);
		fireEvent.click(screen.getByRole("button", { name: "Discuss" }));
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
		expect(urls[2]?.searchParams.has("refresh")).toBe(false);
		expect(urls[2]?.searchParams.has("since")).toBe(false);
		expect(urls[2]?.searchParams.has("until")).toBe(false);
	});

	it("exports a completed discussion through the browser PDF flow", async () => {
		document.title = "birdclaw";
		const printMock = vi.spyOn(window, "print").mockImplementation(() => {
			expect(document.title).toBe("BirdClaw ChatGPT discussion");
			expect(document.body.dataset.todayPrintMode).toBe("summary");
			window.dispatchEvent(new Event("afterprint"));
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				const markdown = "# ChatGPT\n\nDiscussion complete.";
				return ndjsonResponse([
					{
						type: "start",
						context: discussionResult(markdown).context,
						cached: false,
					},
					{ type: "delta", delta: markdown },
					{ type: "done", result: discussionResult(markdown) },
				]);
			}),
		);

		render(<DiscussRoute />);
		const exportButton = screen.getByRole("button", { name: "Export PDF" });
		const fullExportButton = screen.getByRole("button", {
			name: "导出完整 PDF",
		});
		expect(exportButton).toBeDisabled();
		expect(fullExportButton).toBeDisabled();

		fireEvent.change(screen.getByPlaceholderText("Keywords"), {
			target: { value: "ChatGPT" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Discuss" }));

		await screen.findByRole("heading", { name: "ChatGPT", level: 1 });
		expect(exportButton).toBeEnabled();
		expect(fullExportButton).toBeEnabled();
		fireEvent.click(exportButton);

		expect(printMock).toHaveBeenCalledTimes(1);
		expect(document.title).toBe("birdclaw");
		expect(document.body.dataset.todayPrintMode).toBeUndefined();
	});

	it("exports cited discussion sources as a complete reference PDF without rerunning the discussion", async () => {
		document.title = "birdclaw";
		const discussionRequests: URL[] = [];
		const printMock = vi.spyOn(window, "print").mockImplementation(() => {
			try {
				expect(document.title).toBe(
					"BirdClaw ChatGPT discussion reference collection",
				);
				expect(document.body.dataset.todayPrintMode).toBe("reference");
				const referencePdf = screen.getByTestId("discuss-reference-pdf");
				const mediaGrid = referencePdf.querySelector(
					".today-reference-media-pair",
				);
				expect(mediaGrid).toHaveAttribute("data-reference-media-count", "2");
				expect(
					within(referencePdf).getByRole("img", {
						name: "讨论来源图表",
					}),
				).toHaveAttribute(
					"src",
					"https://pbs.twimg.com/media/discuss-chart.jpg",
				);
				expect(
					within(referencePdf).getByRole("img", {
						name: "推文 GIF 封面 2",
					}),
				).toHaveAttribute("src", "https://pbs.twimg.com/media/discuss-gif.jpg");
				expect(
					within(referencePdf).getByRole("heading", {
						name: "BirdClaw Discuss 参考内容合集",
						level: 1,
					}),
				).toBeInTheDocument();
				expect(
					within(referencePdf).getByText(
						"People discuss practical AI workflows.",
					),
				).toBeInTheDocument();
				expect(
					within(referencePdf).getAllByText("Practical workflows"),
				).not.toHaveLength(0);
				expect(
					within(referencePdf).getByText("Summaries stay readable and useful."),
				).toBeInTheDocument();
				expect(
					within(referencePdf).getByText("ChatGPT is useful for summaries."),
				).toBeInTheDocument();
				expect(
					within(referencePdf).getByText(
						"A Markdown-only source is still complete.",
					),
				).toBeInTheDocument();
				expect(
					within(referencePdf).getAllByText("Alice (@alice)"),
				).not.toHaveLength(0);
				expect(within(referencePdf).getAllByText("S01")).not.toHaveLength(0);
				expect(within(referencePdf).getAllByText("S02")).not.toHaveLength(0);
				expect(
					within(referencePdf).getByRole("link", { name: "S01 所在页" }),
				).toHaveAttribute("href", "#reference-source-S01");
				expect(within(referencePdf).getByText("tweet_1")).toBeInTheDocument();
				expect(
					within(referencePdf).getAllByText("2026-05-23"),
				).not.toHaveLength(0);
				expect(within(referencePdf).queryByText(/4 likes|4 赞/)).toBeNull();
				expect(
					within(referencePdf).queryByText(
						"https://x.com/alice/status/tweet_1",
					),
				).toBeNull();
				expect(within(referencePdf).getAllByText("DM")).toHaveLength(9);
				expect(
					within(referencePdf).getByText("Private cited context 9."),
				).toBeInTheDocument();
				expect(
					screen.getByRole("button", { name: "Export PDF" }),
				).toBeDisabled();
				expect(
					screen.getByRole("button", { name: "导出完整 PDF" }),
				).toBeDisabled();
				expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
				expect(screen.getByRole("button", { name: "Discuss" })).toBeDisabled();
			} finally {
				window.dispatchEvent(new Event("afterprint"));
			}
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input));
				discussionRequests.push(url);
				const markdown =
					"# ChatGPT\n\n## Themes\n\n- Practical workflows stay readable (tweet_1).\n- A Markdown-only source is still complete (tweet_2).\n- Private context adds nuance (dm_friend).";
				const baseResult = discussionResult(markdown);
				const citedDms = Array.from({ length: 9 }, (_, index) => ({
					id: index === 8 ? "dm:friend" : `dm_${String(index + 1)}`,
					participant: `participant_${String(index + 1)}`,
					name: `Private participant ${String(index + 1)}`,
					lastMessageAt: "2026-05-23T08:19:00.000Z",
					text: `Private cited context ${String(index + 1)}.`,
					needsReply: false,
					influenceScore: 0,
				}));
				const exportResult = {
					...baseResult,
					context: {
						...baseResult.context,
						includeDms: true,
						counts: { ...baseResult.context.counts, dms: citedDms.length },
						tweets: [
							{
								...baseResult.context.tweets[0],
								media: [
									{
										url: "https://pbs.twimg.com/media/discuss-chart.jpg",
										type: "image" as const,
										altText: "讨论来源图表",
										width: 1400,
										height: 900,
									},
									{
										url: "https://video.twimg.com/tweet-video/demo.mp4",
										thumbnailUrl: "https://pbs.twimg.com/media/discuss-gif.jpg",
										type: "gif" as const,
									},
								],
							},
							{
								...baseResult.context.tweets[0],
								id: "tweet_2",
								url: "https://x.com/alice/status/tweet_2",
								text: "A Markdown-only source is still complete.",
								media: [],
							},
						],
						dms: citedDms,
					},
					discussion: {
						...baseResult.discussion,
						themes: baseResult.discussion.themes.map((theme) => ({
							...theme,
							tweetIds: ["tweet_1", "1"],
							dmConversationIds: [],
						})),
						sourceTweetIds: [],
						sourceDmConversationIds: citedDms.slice(0, 8).map((dm) => dm.id),
					},
				};
				return ndjsonResponse([
					{
						type: "start",
						context: exportResult.context,
						cached: false,
					},
					{ type: "delta", delta: markdown },
					{ type: "done", result: exportResult },
				]);
			}),
		);

		render(<DiscussRoute />);
		fireEvent.change(screen.getByPlaceholderText("Keywords"), {
			target: { value: "ChatGPT" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Discuss" }));

		await screen.findByRole("heading", { name: "ChatGPT", level: 1 });
		expect(discussionRequests).toHaveLength(1);
		fireEvent.click(screen.getByRole("button", { name: "导出完整 PDF" }));

		expect(printMock).toHaveBeenCalledTimes(1);
		expect(discussionRequests).toHaveLength(1);
		expect(document.title).toBe("birdclaw");
		expect(document.body.dataset.todayPrintMode).toBeUndefined();
	});

	it("applies a custom local date-time range to the submitted discussion", async () => {
		const urls: URL[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input));
				urls.push(url);
				const markdown = "# Custom range\n\nDone.";
				return ndjsonResponse([
					{
						type: "done",
						result: discussionResult(markdown),
					},
				]);
			}),
		);

		render(<DiscussRoute />);
		fireEvent.change(screen.getByPlaceholderText("Keywords"), {
			target: { value: "BirdClaw" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Custom" }));
		expect(
			screen.getByRole("group", { name: "Custom date range" }),
		).toBeVisible();

		const sinceLocal = "2026-07-10T09:15";
		const untilLocal = "2026-07-10T11:45";
		fireEvent.change(screen.getByLabelText("From"), {
			target: { value: sinceLocal },
		});
		fireEvent.change(screen.getByLabelText("To"), {
			target: { value: untilLocal },
		});
		expect(urls).toHaveLength(0);

		fireEvent.click(screen.getByRole("button", { name: "Apply custom range" }));
		expect(urls).toHaveLength(0);
		fireEvent.click(screen.getByRole("button", { name: "Discuss" }));
		await waitFor(() => expect(urls).toHaveLength(1));
		expect(urls[0]?.searchParams.get("since")).toBe(
			new Date(sinceLocal).toISOString(),
		);
		expect(urls[0]?.searchParams.get("until")).toBe(
			new Date(untilLocal).toISOString(),
		);

		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await waitFor(() => expect(urls).toHaveLength(2));
		expect(urls[1]?.searchParams.get("since")).toBe(
			urls[0]?.searchParams.get("since"),
		);
		expect(urls[1]?.searchParams.get("until")).toBe(
			urls[0]?.searchParams.get("until"),
		);

		fireEvent.click(screen.getByRole("button", { name: "All" }));
		fireEvent.click(screen.getByRole("button", { name: "Discuss" }));
		await waitFor(() => expect(urls).toHaveLength(3));
		expect(urls[2]?.searchParams.has("since")).toBe(false);
		expect(urls[2]?.searchParams.has("until")).toBe(false);
	});

	it("closes a restored custom picker when navigation returns to All", () => {
		const onSearchChange = vi.fn();
		const customSearch = validateDiscussSearch({
			range: "custom",
			since: "2026-07-10T09:15:00.000Z",
			until: "2026-07-10T11:45:00.000Z",
		});
		const { rerender } = render(
			<DiscussRoute
				searchState={customSearch}
				onSearchChange={onSearchChange}
			/>,
		);
		expect(
			screen.getByRole("group", { name: "Custom date range" }),
		).toBeVisible();

		rerender(
			<DiscussRoute
				searchState={validateDiscussSearch({ range: "all" })}
				onSearchChange={onSearchChange}
			/>,
		);
		expect(
			screen.queryByRole("group", { name: "Custom date range" }),
		).toBeNull();
		expect(screen.getByRole("button", { name: "All" })).toHaveClass(
			"!bg-[var(--accent)]",
		);
	});

	it("preserves Chinese IME composition before syncing route search", () => {
		const onSearchChange = vi.fn();
		const searchState = validateDiscussSearch({});

		render(
			<DiscussRoute
				searchState={searchState}
				onSearchChange={onSearchChange}
			/>,
		);

		const keywords = screen.getByPlaceholderText("Keywords");
		fireEvent.compositionStart(keywords);
		fireEvent.change(keywords, { target: { value: "zhong" } });
		expect(keywords).toHaveValue("zhong");
		expect(onSearchChange).not.toHaveBeenCalled();

		fireEvent.change(keywords, { target: { value: "中文" } });
		fireEvent.compositionEnd(keywords);
		expect(keywords).toHaveValue("中文");
		expect(onSearchChange).toHaveBeenLastCalledWith(
			{ ...searchState, q: "中文" },
			{ replace: true },
		);

		onSearchChange.mockClear();
		const question = screen.getByPlaceholderText("Optional question");
		fireEvent.compositionStart(question);
		fireEvent.change(question, { target: { value: "这个话题怎么样" } });
		expect(question).toHaveValue("这个话题怎么样");
		expect(onSearchChange).not.toHaveBeenCalled();

		fireEvent.compositionEnd(question);
		expect(onSearchChange).toHaveBeenLastCalledWith(
			{ ...searchState, question: "这个话题怎么样" },
			{ replace: true },
		);
	});

	it("renders request and stream errors", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ message: "no api key" }), {
					status: 500,
					statusText: "Server Error",
					headers: { "content-type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				ndjsonResponse([{ type: "error", error: "live failed" }]),
			);
		vi.stubGlobal("fetch", fetchMock);

		render(<DiscussRoute />);
		fireEvent.change(screen.getByPlaceholderText("Keywords"), {
			target: { value: "OpenAI" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Discuss" }));

		expect(
			await screen.findByText(
				"Discussion request failed (500 Server Error): no api key",
			),
		).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Discuss" }));
		expect(await screen.findByText("live failed")).toBeInTheDocument();
	});

	it("renders non-json and empty-body request failures", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response("plain failure", {
					status: 503,
					statusText: "",
				}),
			)
			.mockResolvedValueOnce(new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetchMock);

		render(<DiscussRoute />);
		fireEvent.change(screen.getByPlaceholderText("Keywords"), {
			target: { value: "OpenAI" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Discuss" }));

		expect(
			await screen.findByText("Discussion request failed (503): plain failure"),
		).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Discuss" }));
		expect(
			await screen.findByText("Discussion request failed: empty response body"),
		).toBeInTheDocument();
	});

	it("renders json error payloads and malformed responses", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ error: "xurl unauthorized" }), {
					status: 401,
					statusText: "Unauthorized",
					headers: { "content-type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response("{not-json", {
					status: 502,
					statusText: "Bad Gateway",
					headers: { "content-type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(new Response("{not-json\n"));
		vi.stubGlobal("fetch", fetchMock);

		render(<DiscussRoute />);
		fireEvent.change(screen.getByPlaceholderText("Keywords"), {
			target: { value: "OpenAI" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Discuss" }));

		expect(
			await screen.findByText(
				"Discussion request failed (401 Unauthorized): xurl unauthorized",
			),
		).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Discuss" }));
		expect(
			await screen.findByText("Discussion request failed (502 Bad Gateway)"),
		).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Discuss" }));
		expect(
			await screen.findByText((content) =>
				/JSON|Unexpected|Expected|not valid/.test(content),
			),
		).toBeInTheDocument();
	});

	it("reports a stream that closes before a terminal event", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ndjsonResponse([{ type: "delta", delta: "partial" }])),
		);

		render(<DiscussRoute />);
		fireEvent.change(screen.getByPlaceholderText("Keywords"), {
			target: { value: "OpenAI" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Discuss" }));

		expect(
			await screen.findByText(
				"Discussion connection closed before completion. Retry to continue.",
			),
		).toBeInTheDocument();
	});
});
