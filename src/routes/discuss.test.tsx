import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateDiscussSearch } from "#/lib/route-search";
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
			themes: [],
			tensions: [],
			followUps: [],
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
