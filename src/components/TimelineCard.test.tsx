import {
	cleanup,
	fireEvent,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { ConversationSurfaceScope } from "#/lib/conversation-surface";
import { renderWithQueryClient } from "#/test/render";
import { TimelineCard } from "./TimelineCard";

const { exportReferenceCollectionPdfMock } = vi.hoisted(() => ({
	exportReferenceCollectionPdfMock: vi.fn(),
}));
const { requestTweetScoreMock } = vi.hoisted(() => ({
	requestTweetScoreMock: vi.fn(() => new Promise(() => {})),
}));

vi.mock("#/lib/pdf-export-client", () => ({
	exportReferenceCollectionPdf: exportReferenceCollectionPdfMock,
}));
vi.mock("#/lib/tweet-score-client", () => ({
	requestTweetScore: requestTweetScoreMock,
}));

function render(ui: ReactNode) {
	const result = renderWithQueryClient(
		<ConversationSurfaceScope>{ui}</ConversationSurfaceScope>,
	);
	return {
		...result,
		rerender: (nextUi: ReactNode) =>
			result.rerender(
				<ConversationSurfaceScope>{nextUi}</ConversationSurfaceScope>,
			),
	};
}

const item = {
	id: "tweet_1",
	accountId: "acct_primary",
	accountHandle: "@steipete",
	kind: "home" as const,
	text: "Ship with @sam https://t.co/demo",
	createdAt: "2026-03-08T12:00:00.000Z",
	isReplied: false,
	likeCount: 12,
	mediaCount: 1,
	bookmarked: true,
	liked: true,
	author: {
		id: "profile_1",
		handle: "sam",
		displayName: "Sam Altman",
		bio: "bio",
		followersCount: 12345,
		avatarHue: 210,
		createdAt: "2026-03-08T12:00:00.000Z",
	},
	entities: {
		mentions: [
			{
				username: "sam",
				id: "profile_1",
				start: 10,
				end: 14,
				profile: {
					id: "profile_1",
					handle: "sam",
					displayName: "Sam Altman",
					bio: "bio",
					followersCount: 12345,
					avatarHue: 210,
					createdAt: "2026-03-08T12:00:00.000Z",
				},
			},
		],
		urls: [
			{
				url: "https://t.co/demo",
				expandedUrl: "https://example.com/demo",
				displayUrl: "example.com/demo",
				start: 15,
				end: 32,
				title: "Demo link",
				description: "Link preview card",
				imageUrl: "https://example.com/preview.jpg",
				siteName: "Example",
			},
		],
	},
	media: [
		{
			url: "https://example.com/demo.jpg",
			type: "image" as const,
			altText: "Demo image",
		},
	],
	replyToTweet: {
		id: "tweet_0",
		text: "Earlier tweet",
		createdAt: "2026-03-08T11:00:00.000Z",
		author: {
			id: "profile_2",
			handle: "destraynor",
			displayName: "Des Traynor",
			bio: "Product",
			followersCount: 200,
			avatarHue: 90,
			createdAt: "2026-03-08T10:00:00.000Z",
		},
		entities: {},
		media: [],
	},
	quotedTweet: {
		id: "tweet_q",
		text: "Quoted tweet",
		createdAt: "2026-03-08T10:00:00.000Z",
		author: {
			id: "profile_3",
			handle: "ava",
			displayName: "Ava",
			bio: "Reporter",
			followersCount: 400,
			avatarHue: 120,
			createdAt: "2026-03-08T09:00:00.000Z",
		},
		entities: {},
		media: [],
	},
};

describe("TimelineCard", () => {
	afterEach(() => {
		cleanup();
		exportReferenceCollectionPdfMock.mockReset();
		requestTweetScoreMock.mockReset();
		requestTweetScoreMock.mockImplementation(() => new Promise(() => {}));
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("renders tweet metadata and replies", () => {
		const onReply = vi.fn();
		const { container } = render(
			<TimelineCard item={item} onReply={onReply} />,
		);

		expect(screen.getByText(/Ship with/)).toBeInTheDocument();
		expect(screen.getAllByText("@sam")[0]).toBeInTheDocument();
		expect(screen.getByText("Earlier tweet")).toBeInTheDocument();
		expect(screen.getAllByText("Quoted tweet")[1]).toBeInTheDocument();
		expect(screen.getByAltText("Demo image")).toBeInTheDocument();
		expect(screen.getByText("Demo link")).toBeInTheDocument();
		expect(
			screen.queryByRole("img", { name: "Demo link" }),
		).not.toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Reply open" })).toHaveAttribute(
			"href",
			"https://x.com/sam/status/tweet_1",
		);
		expect(screen.getByRole("link", { name: "Reply open" })).toHaveAttribute(
			"target",
			"_blank",
		);
		expect(screen.getByRole("link", { name: "Reply open" })).toHaveClass(
			"reply-open-pill",
		);
		expect(container.querySelectorAll("header p")).toHaveLength(0);
		fireEvent.click(screen.getByRole("button", { name: "Reply" }));
		expect(onReply).toHaveBeenCalledWith("tweet_1");
	});

	it("prints one tweet through the existing reference PDF layout", () => {
		exportReferenceCollectionPdfMock.mockImplementation(
			({
				onCleanup,
				sourceSelector,
			}: {
				onCleanup: () => void;
				sourceSelector: string;
			}) => {
				const source = document.querySelector(sourceSelector);
				expect(source).toHaveAttribute("aria-label", "可打印推文");
				expect(source).toHaveTextContent("Sam Altman (@sam)");
				expect(source).toHaveTextContent("Ship with @sam");
				expect(source).toHaveTextContent("回复上下文：@destraynor");
				expect(source).toHaveTextContent("引用推文：Ava (@ava)");
				onCleanup();
				return Promise.resolve();
			},
		);

		render(<TimelineCard item={item} onReply={vi.fn()} />);

		const printButton = screen.getByRole("button", { name: "Print tweet" });
		const openLink = screen.getByRole("link", { name: "Reply open" });
		expect(
			printButton.compareDocumentPosition(openLink) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		fireEvent.click(printButton);

		expect(exportReferenceCollectionPdfMock).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "BirdClaw @sam tweet",
				onCleanup: expect.any(Function),
				sourceSelector: expect.stringMatching(/^#timeline-tweet-print-/),
			}),
		);
		expect(
			screen.getByRole("button", { name: "Show conversation" }),
		).toHaveAttribute("aria-expanded", "false");
		expect(screen.queryByLabelText("可打印推文")).toBeNull();
	});

	it("shows print only beside an actionable Open link", () => {
		render(
			<TimelineCard item={item} onReply={vi.fn()} showReplyControls={false} />,
		);

		expect(screen.queryByRole("button", { name: "Print tweet" })).toBeNull();
		expect(screen.queryByRole("link", { name: "Reply open" })).toBeNull();
	});

	it("prints the displayed original tweet from a native repost", () => {
		exportReferenceCollectionPdfMock.mockImplementation(
			({
				onCleanup,
				sourceSelector,
			}: {
				onCleanup: () => void;
				sourceSelector: string;
			}) => {
				const source = document.querySelector(sourceSelector);
				expect(source).toHaveTextContent("Ava (@ava)");
				expect(source).toHaveTextContent("Original app idea");
				expect(source).not.toHaveTextContent("Ship with @sam");
				onCleanup();
				return Promise.resolve();
			},
		);
		render(
			<TimelineCard
				item={{
					...item,
					id: "tweet_rt",
					text: "RT @ava: Original app idea",
					retweetedTweet: {
						id: "tweet_original",
						text: "Original app idea",
						createdAt: "2026-03-08T11:55:00.000Z",
						author: item.quotedTweet.author,
						entities: {},
						media: [],
					},
				}}
				onReply={vi.fn()}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Print tweet" }));

		expect(exportReferenceCollectionPdfMock).toHaveBeenCalledWith(
			expect.objectContaining({ title: "BirdClaw @ava tweet" }),
		);
	});

	it("automatically shows a Chinese translation and toggles back to the original", async () => {
		class VisibleIntersectionObserver {
			private readonly callback: IntersectionObserverCallback;

			constructor(callback: IntersectionObserverCallback) {
				this.callback = callback;
			}

			observe(target: Element) {
				this.callback(
					[
						{
							isIntersecting: true,
							target,
						} as IntersectionObserverEntry,
					],
					this as unknown as IntersectionObserver,
				);
			}

			disconnect() {}
			unobserve() {}
			takeRecords() {
				return [];
			}
			readonly root = null;
			readonly rootMargin = "320px 0px";
			readonly thresholds = [0];
		}
		vi.stubGlobal("IntersectionObserver", VisibleIntersectionObserver);
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe("/api/tweet-translation");
				expect(init?.method).toBe("POST");
				expect(JSON.parse(String(init?.body))).toEqual({
					tweetId: "tweet_korean",
					text: "새 버전을 오늘 출시합니다.",
					targetLanguage: "zh-CN",
				});
				return new Response(
					JSON.stringify({
						ok: true,
						tweetId: "tweet_korean",
						targetLanguage: "zh-CN",
						sourceLanguage: "Korean",
						translated: true,
						translatedText: "今天发布新版本。",
						cached: false,
					}),
					{ status: 200 },
				);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		render(
			<TimelineCard
				item={{
					...item,
					id: "tweet_korean",
					text: "새 버전을 오늘 출시합니다.",
					entities: {},
					media: [],
					mediaCount: 0,
					replyToTweet: null,
					quotedTweet: null,
				}}
				onReply={vi.fn()}
			/>,
		);

		expect(await screen.findByText("今天发布新版本。")).toBeInTheDocument();
		expect(screen.queryByText("새 버전을 오늘 출시합니다.")).toBeNull();
		expect(screen.getByText("AI 翻译")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "显示原文" }));
		expect(screen.getByText("새 버전을 오늘 출시합니다.")).toBeInTheDocument();
		expect(screen.queryByText("今天发布新版本。")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "显示翻译" }));
		expect(screen.getByText("今天发布新版本。")).toBeInTheDocument();
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("automatically translates a quoted tweet with an independent original toggle", async () => {
		class VisibleIntersectionObserver {
			private readonly callback: IntersectionObserverCallback;

			constructor(callback: IntersectionObserverCallback) {
				this.callback = callback;
			}

			observe(target: Element) {
				this.callback(
					[
						{
							isIntersecting: true,
							target,
						} as IntersectionObserverEntry,
					],
					this as unknown as IntersectionObserver,
				);
			}

			disconnect() {}
			unobserve() {}
			takeRecords() {
				return [];
			}
			readonly root = null;
			readonly rootMargin = "320px 0px";
			readonly thresholds = [0];
		}
		vi.stubGlobal("IntersectionObserver", VisibleIntersectionObserver);
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe("/api/tweet-translation");
				expect(init?.method).toBe("POST");
				expect(JSON.parse(String(init?.body))).toEqual({
					tweetId: "tweet_quote_korean",
					text: "인용된 게시물입니다.",
					targetLanguage: "zh-CN",
				});
				return new Response(
					JSON.stringify({
						ok: true,
						tweetId: "tweet_quote_korean",
						targetLanguage: "zh-CN",
						sourceLanguage: "Korean",
						translated: true,
						translatedText: "这是一条引用帖子。",
						cached: false,
					}),
					{ status: 200 },
				);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		render(
			<TimelineCard
				item={{
					...item,
					text: "这是主帖。",
					entities: {},
					media: [],
					mediaCount: 0,
					replyToTweet: null,
					quotedTweet: {
						...item.quotedTweet,
						id: "tweet_quote_korean",
						text: "인용된 게시물입니다.",
					},
				}}
				onReply={vi.fn()}
			/>,
		);

		expect(await screen.findByText("这是一条引用帖子。")).toBeInTheDocument();
		expect(screen.queryByText("인용된 게시물입니다.")).toBeNull();
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(
			screen.getByRole("button", { name: "Show conversation" }),
		).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "显示引用原文" }));
		expect(screen.getByText("인용된 게시물입니다.")).toBeInTheDocument();
		expect(screen.queryByText("这是一条引用帖子。")).toBeNull();
		expect(
			screen.queryByRole("button", { name: "Hide conversation" }),
		).toBeNull();
		expect(
			screen.getByRole("button", { name: "Show conversation" }),
		).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "显示引用翻译" }));
		expect(screen.getByText("这是一条引用帖子。")).toBeInTheDocument();
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("links the displayed avatar to a local author timeline without opening the thread", () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		render(<TimelineCard item={item} onReply={vi.fn()} />);

		const avatarLink = screen.getByRole("link", {
			name: "View @sam local posts",
		});
		expect(avatarLink).toHaveAttribute("href", "/authors/sam");
		avatarLink.addEventListener("click", (event) => event.preventDefault(), {
			once: true,
		});
		fireEvent.click(avatarLink);
		expect(fetchMock).not.toHaveBeenCalled();

		fireEvent.pointerEnter(avatarLink.parentElement as HTMLElement);
		expect(
			screen.getByRole("group", { name: "Sam Altman profile preview" }),
		).toBeInTheDocument();
	});

	it("places the numeric score in the avatar column", async () => {
		class VisibleIntersectionObserver {
			private readonly callback: IntersectionObserverCallback;

			constructor(callback: IntersectionObserverCallback) {
				this.callback = callback;
			}

			observe(element: Element) {
				this.callback(
					[
						{
							isIntersecting: true,
							target: element,
						} as IntersectionObserverEntry,
					],
					this as unknown as IntersectionObserver,
				);
			}

			disconnect() {}
			unobserve() {}
			takeRecords() {
				return [];
			}
			root = null;
			rootMargin = "0px";
			thresholds = [0];
		}
		vi.stubGlobal("IntersectionObserver", VisibleIntersectionObserver);
		requestTweetScoreMock.mockResolvedValue({
			tweetId: "tweet_1",
			score: 8,
			label: "高信息价值",
			dimensions: {
				informationDelta: 4,
				clearThesis: 2,
				explainedMechanism: 1,
				verifiability: 1,
				clearBoundaries: 0,
			},
			sentiment: "positive",
			assets: ["股票"],
			reason: "有明确的新信息。",
			explanation: "作者给出了事实和结论。",
			updatedAt: "2026-08-12T08:00:00.000Z",
			cached: false,
		});

		render(<TimelineCard item={item} onReply={vi.fn()} />);
		const avatar = screen.getByRole("link", {
			name: "View @sam local posts",
		});
		const scoreButton = await screen.findByRole("button", {
			name: /帖子评分 8 分/,
		});
		const avatarColumn = avatar.parentElement?.parentElement;
		expect(avatarColumn).toContainElement(scoreButton);
		expect(avatarColumn).toHaveClass("flex-col", "gap-3");
		expect(scoreButton).toHaveTextContent(/^8$/);
	});

	it("uses the author homepage for identity links and keeps explicit analysis links direct", () => {
		render(<TimelineCard item={item} onReply={vi.fn()} />);

		expect(
			screen.getByRole("link", { name: "Sam Altman@sam" }),
		).toHaveAttribute("href", "/authors/sam");
		expect(screen.getByRole("link", { name: "Analyse @sam" })).toHaveAttribute(
			"href",
			"/profiles/sam",
		);
	});

	it("toggles a local bookmark without changing the imported bookmark marker", async () => {
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe("/api/bookmark");
				expect(init?.method).toBe("POST");
				expect(JSON.parse(String(init?.body))).toEqual({
					accountId: "acct_primary",
					tweetId: "tweet_1",
					bookmarked: true,
				});
				return Response.json({
					ok: true,
					accountId: "acct_primary",
					tweetId: "tweet_1",
					bookmarked: true,
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		render(
			<TimelineCard
				item={{ ...item, localBookmarked: false }}
				onReply={vi.fn()}
			/>,
		);

		expect(
			screen.getByLabelText("Saved on X or in an imported archive"),
		).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Bookmark locally" }));

		expect(
			await screen.findByRole("button", { name: "Remove local bookmark" }),
		).toHaveAttribute("aria-pressed", "true");
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
	});

	it("keeps the local bookmark in the primary mobile action row before likes", () => {
		const { container } = render(
			<TimelineCard
				item={{ ...item, localBookmarked: false }}
				onReply={vi.fn()}
			/>,
		);

		const actionBar = container.querySelector('[data-perf="timeline-actions"]');
		expect(actionBar).not.toBeNull();
		expect(actionBar?.firstElementChild).toHaveClass("max-sm:grid");
		const actionItems = Array.from(
			actionBar?.firstElementChild?.children ?? [],
		);
		const bookmarkButton = screen.getByRole("button", {
			name: "Bookmark locally",
		});
		const likes = screen.getByLabelText("12 likes");
		expect(actionItems.indexOf(bookmarkButton)).toBeGreaterThanOrEqual(0);
		expect(actionItems.indexOf(bookmarkButton)).toBeLessThan(
			actionItems.indexOf(likes),
		);
		expect(bookmarkButton).toHaveClass("max-sm:min-h-11");
		expect(
			screen.getByLabelText("Saved on X or in an imported archive"),
		).toHaveClass("max-sm:hidden");
		expect(screen.getByLabelText("1 media attachments")).toHaveClass(
			"max-sm:hidden",
		);
	});

	it("rolls back an optimistic local bookmark when persistence fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					Response.json(
						{ ok: false, message: "Database unavailable" },
						{ status: 500 },
					),
				),
		);
		render(
			<TimelineCard
				item={{ ...item, bookmarked: false, localBookmarked: false }}
				onReply={vi.fn()}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Bookmark locally" }));
		expect(
			await screen.findByText("Couldn’t update bookmark."),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Bookmark locally" }),
		).toHaveAttribute("aria-pressed", "false");
	});

	it("rolls a failed second update back to the last successful bookmark state", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json({
					ok: true,
					accountId: "acct_primary",
					tweetId: "tweet_1",
					bookmarked: true,
				}),
			)
			.mockResolvedValueOnce(
				Response.json(
					{ ok: false, message: "Database unavailable" },
					{ status: 500 },
				),
			);
		vi.stubGlobal("fetch", fetchMock);
		render(
			<TimelineCard
				item={{ ...item, bookmarked: false, localBookmarked: false }}
				onReply={vi.fn()}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Bookmark locally" }));
		const removeButton = await screen.findByRole("button", {
			name: "Remove local bookmark",
		});
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

		fireEvent.click(removeButton);
		expect(
			await screen.findByText("Couldn’t update bookmark."),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Remove local bookmark" }),
		).toHaveAttribute("aria-pressed", "true");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("keeps Chinese prose outside adjacent fallback t.co links", () => {
		const text =
			"参见https://t.co/fx3GCU2zF8，市场转暖；这里https://t.co/QVugYmhuPc有聊。";
		const { container } = render(
			<TimelineCard
				item={{
					...item,
					text,
					entities: {},
					media: [],
					mediaCount: 0,
					replyToTweet: null,
					quotedTweet: null,
				}}
				onReply={vi.fn()}
			/>,
		);

		expect(
			screen.getByRole("link", { name: "t.co/fx3GCU2zF8" }),
		).toHaveAttribute("href", "https://t.co/fx3GCU2zF8");
		expect(
			screen.getByRole("link", { name: "t.co/QVugYmhuPc" }),
		).toHaveAttribute("href", "https://t.co/QVugYmhuPc");
		expect(container).toHaveTextContent("，市场转暖；这里");
		expect(container.textContent).not.toContain("%EF%BC");
	});

	it("renders an imported X Remark annotation for the displayed author", () => {
		render(
			<TimelineCard
				item={{
					...item,
					author: {
						...item.author,
						xRemark: {
							identifier: "42",
							handle: "sam",
							remark: "Met at WWDC",
							description: "Interested in local-first products",
							tags: ["Founder", "AI"],
							category: "People",
						},
					},
				}}
				onReply={vi.fn()}
			/>,
		);

		expect(screen.getByText("X Remark")).toBeInTheDocument();
		expect(screen.getByText("Met at WWDC")).toBeInTheDocument();
		expect(
			screen.getByText("Interested in local-first products"),
		).toBeInTheDocument();
		expect(screen.getByText("#Founder")).toBeInTheDocument();
		expect(screen.getByText("People")).toBeInTheDocument();
	});

	it("renders retweets as the original tweet with repost attribution", () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ ok: true, anchorId: "tweet_original", items: [] }),
		});
		vi.stubGlobal("fetch", fetchMock);
		const onReply = vi.fn();
		const { container } = render(
			<TimelineCard
				item={{
					...item,
					id: "tweet_rt",
					text: "RT @ava: Original app idea",
					entities: {},
					media: [],
					mediaCount: 0,
					replyToTweet: null,
					quotedTweet: null,
					retweetedTweet: {
						id: "tweet_original",
						text: "Original app idea",
						createdAt: "2026-03-08T11:55:00.000Z",
						isReplied: true,
						likeCount: 7,
						mediaCount: 0,
						bookmarked: false,
						liked: false,
						author: {
							id: "profile_3",
							handle: "ava",
							displayName: "Ava",
							bio: "Reporter",
							followersCount: 400,
							avatarHue: 120,
							avatarUrl: "https://example.com/ava.jpg",
							createdAt: "2026-03-08T09:00:00.000Z",
						},
						entities: {},
						media: [],
					},
				}}
				onReply={onReply}
			/>,
		);

		expect(screen.getByText("Sam Altman reposted")).toBeInTheDocument();
		expect(screen.getAllByAltText("Ava")[0]).toHaveAttribute(
			"src",
			expect.stringContaining("/api/avatar?profileId=profile_3&v="),
		);
		expect(
			screen.getByRole("link", { name: "View @ava local posts" }),
		).toHaveAttribute("href", "/authors/ava");
		expect(screen.getByText("Original app idea")).toBeInTheDocument();
		expect(screen.getAllByText("@ava").length).toBeGreaterThan(0);
		expect(screen.getByLabelText("We replied")).toBeInTheDocument();
		expect(screen.queryByRole("link", { name: "Reply open" })).toBeNull();
		expect(screen.getByText("7")).toBeInTheDocument();
		expect(screen.queryByText("not bookmarked")).not.toBeInTheDocument();
		expect(screen.queryByText("Reposted tweet")).not.toBeInTheDocument();
		expect(screen.queryByText(/RT @ava/)).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Reply" }));
		expect(onReply).toHaveBeenCalledWith("tweet_original");

		const row = container.querySelector("[data-perf='timeline-card']");
		if (!row) throw new Error("timeline card missing");
		fireEvent.click(row);
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/conversation?tweetId=tweet_original",
		);
	});

	it("uses the wrapper tweet id for manual retweet interactions", () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ ok: true, anchorId: "tweet_manual", items: [] }),
		});
		vi.stubGlobal("fetch", fetchMock);
		const onReply = vi.fn();
		const { container } = render(
			<TimelineCard
				item={{
					...item,
					id: "tweet_manual",
					text: "RT @ava: Original app idea",
					entities: {},
					media: [],
					mediaCount: 0,
					replyToTweet: null,
					quotedTweet: null,
					retweetedTweet: {
						id: "tweet_manual:retweeted",
						text: "Original app idea",
						createdAt: "2026-03-08T11:55:00.000Z",
						author: {
							id: "profile_3",
							handle: "ava",
							displayName: "Ava",
							bio: "Reporter",
							followersCount: 400,
							avatarHue: 120,
							createdAt: "2026-03-08T09:00:00.000Z",
						},
						entities: {},
						media: [
							{
								url: "https://example.com/manual-retweet.jpg",
								type: "image",
								altText: "Manual repost media",
							},
						],
					},
				}}
				onReply={onReply}
			/>,
		);

		expect(screen.getByText("Original app idea")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Reply open" })).toHaveAttribute(
			"href",
			"https://x.com/sam/status/tweet_manual",
		);
		fireEvent.click(screen.getByRole("button", { name: "Open tweet media 1" }));
		expect(
			screen.getByRole("link", { name: "Open @ava on X" }),
		).toHaveAttribute("href", "https://x.com/sam/status/tweet_manual");
		fireEvent.click(screen.getByRole("button", { name: "Close media viewer" }));
		fireEvent.click(screen.getByRole("button", { name: "Reply" }));
		expect(onReply).toHaveBeenCalledWith("tweet_manual");

		const row = container.querySelector("[data-perf='timeline-card']");
		if (!row) throw new Error("timeline card missing");
		fireEvent.click(row);
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/conversation?tweetId=tweet_manual",
		);
	});

	it("expands a truncated manual repost in place and collapses it again", async () => {
		const shortText = "A long repost starts here and then stops…";
		const fullText =
			"A long repost starts here and then stops being truncated.\n\nThis is the complete long-form post, shown inside BirdClaw.";
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				ok: true,
				tweetId: "tweet_manual_long",
				sourceTweetId: "tweet_original_long",
				text: fullText,
			}),
		});
		vi.stubGlobal("fetch", fetchMock);
		const { container } = render(
			<TimelineCard
				item={{
					...item,
					id: "tweet_manual_long",
					text: `RT @ava: ${shortText}`,
					entities: {},
					media: [],
					mediaCount: 0,
					replyToTweet: null,
					quotedTweet: null,
					retweetedTweet: {
						id: "tweet_manual_long:retweeted",
						text: shortText,
						createdAt: "2026-03-08T11:55:00.000Z",
						author: {
							id: "profile_3",
							handle: "ava",
							displayName: "Ava",
							bio: "Reporter",
							followersCount: 400,
							avatarHue: 120,
							createdAt: "2026-03-08T09:00:00.000Z",
						},
						entities: {},
						media: [],
					},
				}}
				onReply={vi.fn()}
			/>,
		);

		expect(screen.getByText(shortText)).toBeInTheDocument();
		expect(screen.getByText("Show more")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Show full repost" }));

		expect(
			await screen.findByText(
				(_content, node) =>
					node?.tagName === "P" && node.textContent === fullText,
			),
		).toBeInTheDocument();
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"/api/tweet-expand?tweetId=tweet_manual_long",
		);
		expect(
			screen.getByRole("button", { name: "Collapse repost" }),
		).toHaveTextContent("Show less");
		expect(screen.getByRole("link", { name: "Reply open" })).toHaveAttribute(
			"href",
			"https://x.com/ava/status/tweet_original_long",
		);

		fireEvent.click(screen.getByRole("button", { name: "Collapse repost" }));
		expect(screen.getByText(shortText)).toBeInTheDocument();
		expect(screen.queryByText(fullText)).toBeNull();
		const row = container.querySelector("[data-perf='timeline-card']");
		if (!row) throw new Error("timeline card missing");
		expect(
			within(row as HTMLElement).getByRole("button", {
				name: "Show full repost",
			}),
		).toHaveAttribute("aria-expanded", "false");
	});

	it("does not offer expansion for a complete native repost", () => {
		render(
			<TimelineCard
				item={{
					...item,
					id: "tweet_native_complete",
					retweetedTweet: {
						id: "tweet_original_complete",
						text: "This native repost is already complete.",
						createdAt: "2026-03-08T11:55:00.000Z",
						author: item.author,
						entities: {},
						media: [],
					},
				}}
				onReply={vi.fn()}
			/>,
		);

		expect(
			screen.queryByRole("button", { name: "Show full repost" }),
		).toBeNull();
	});

	it("keeps the repost in place when expansion fails and can retry", async () => {
		const shortText = "A truncated repost that can be retried…";
		const fullText = "A truncated repost that can be retried successfully.";
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce({
				ok: false,
				status: 502,
				json: async () => ({ ok: false, error: "Full repost unavailable" }),
			})
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					ok: true,
					tweetId: "2077304879635411112",
					sourceTweetId: "2076981334246138273",
					text: fullText,
				}),
			});
		vi.stubGlobal("fetch", fetchMock);
		render(
			<TimelineCard
				item={{
					...item,
					id: "2077304879635411112",
					text: `RT @ava: ${shortText}`,
					entities: {},
					media: [],
					mediaCount: 0,
					retweetedTweet: {
						id: "2077304879635411112:retweeted",
						text: shortText,
						createdAt: "2026-07-15T08:10:52.000Z",
						author: item.author,
						entities: {},
						media: [],
					},
				}}
				onReply={vi.fn()}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Show full repost" }));
		expect(
			await screen.findByText("Couldn’t load the full post."),
		).toBeInTheDocument();
		expect(screen.getByText(shortText)).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Show conversation" }),
		).toHaveAttribute("aria-expanded", "false");

		fireEvent.click(screen.getByRole("button", { name: "Retry full repost" }));
		expect(await screen.findByText(fullText)).toBeInTheDocument();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("keeps duplicate retweet rows independently expandable", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				ok: true,
				anchorId: "tweet_original",
				items: [
					{
						id: "tweet_original",
						text: "Original conversation",
						createdAt: "2026-03-08T11:55:00.000Z",
						replyToId: null,
						author: item.author,
						entities: {},
						media: [],
					},
					{
						id: "tweet_original_reply",
						text: "Reply in conversation",
						createdAt: "2026-03-08T11:56:00.000Z",
						replyToId: "tweet_original",
						author: item.author,
						entities: {},
						media: [],
					},
				],
			}),
		});
		vi.stubGlobal("fetch", fetchMock);
		const retweetedTweet = {
			id: "tweet_original",
			text: "Original app idea",
			createdAt: "2026-03-08T11:55:00.000Z",
			author: {
				id: "profile_3",
				handle: "ava",
				displayName: "Ava",
				bio: "Reporter",
				followersCount: 400,
				avatarHue: 120,
				createdAt: "2026-03-08T09:00:00.000Z",
			},
			entities: {},
			media: [],
		};
		const { container } = render(
			<>
				<TimelineCard
					item={{ ...item, id: "tweet_rt_a", retweetedTweet }}
					onReply={vi.fn()}
				/>
				<TimelineCard
					item={{ ...item, id: "tweet_rt_b", retweetedTweet }}
					onReply={vi.fn()}
				/>
			</>,
		);
		const rows = container.querySelectorAll("[data-perf='timeline-card']");
		const first = rows[0];
		const second = rows[1];
		if (!first || !second) throw new Error("timeline cards missing");
		expect(
			within(first as HTMLElement).getByRole("link", { name: "Reply open" }),
		).toHaveAttribute("href", "https://x.com/ava/status/tweet_original");

		fireEvent.click(first);

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/conversation?tweetId=tweet_original",
		);
		expect(
			within(first as HTMLElement).getByRole("button", {
				name: "Hide conversation",
			}),
		).toHaveAttribute("aria-expanded", "true");
		expect(
			within(second as HTMLElement).getByRole("button", {
				name: "Show conversation",
			}),
		).toHaveAttribute("aria-expanded", "false");
		expect(
			await screen.findByText("Original conversation"),
		).toBeInTheDocument();
	});

	it("keeps link preview cards on native retweets", () => {
		render(
			<TimelineCard
				item={{
					...item,
					id: "tweet_retweet_link",
					text: "RT @ava: Original link https://t.co/orig",
					entities: {},
					media: [],
					mediaCount: 0,
					replyToTweet: null,
					quotedTweet: null,
					retweetedTweet: {
						id: "tweet_original_link",
						text: "Original link https://t.co/orig",
						createdAt: "2026-03-08T11:55:00.000Z",
						author: {
							id: "profile_3",
							handle: "ava",
							displayName: "Ava",
							bio: "Reporter",
							followersCount: 400,
							avatarHue: 120,
							createdAt: "2026-03-08T09:00:00.000Z",
						},
						entities: {
							urls: [
								{
									url: "https://t.co/orig",
									expandedUrl: "https://example.com/original",
									displayUrl: "example.com/original",
									start: 14,
									end: 31,
									title: "Original link preview",
									description: "Preview from original reposted tweet",
									siteName: "Example",
								},
							],
						},
						media: [],
					},
				}}
				onReply={vi.fn()}
			/>,
		);

		expect(screen.getByText("Original link preview")).toBeInTheDocument();
		expect(
			document.querySelector("[data-perf='link-preview-card']"),
		).not.toBeNull();
	});

	it("hides empty passive metadata", () => {
		render(
			<TimelineCard
				item={{
					...item,
					id: "tweet_2",
					isReplied: true,
					bookmarked: false,
					mediaCount: 0,
					media: [],
					replyToTweet: null,
					quotedTweet: null,
					entities: {},
				}}
				onReply={vi.fn()}
			/>,
		);

		expect(screen.getByText("replied")).toBeInTheDocument();
		expect(screen.getByLabelText("We replied")).toBeInTheDocument();
		expect(screen.queryByText("not bookmarked")).not.toBeInTheDocument();
		expect(screen.queryByText("0 media")).not.toBeInTheDocument();
		expect(screen.queryByText("@steipete")).not.toBeInTheDocument();
	});

	it("does not render reply state or actions for likes and bookmarks", () => {
		const onReply = vi.fn();
		const { container, rerender } = render(
			<TimelineCard
				item={{
					...item,
					kind: "like",
					isReplied: false,
					replyToTweet: null,
					quotedTweet: null,
				}}
				onReply={onReply}
				showReplyControls={false}
			/>,
		);
		const queries = within(container);

		expect(queries.queryByText("needs reply")).not.toBeInTheDocument();
		expect(queries.queryByText("replied")).not.toBeInTheDocument();
		expect(queries.queryByText("open")).not.toBeInTheDocument();
		expect(
			queries.queryByRole("button", { name: "Reply" }),
		).not.toBeInTheDocument();

		rerender(
			<TimelineCard
				item={{
					...item,
					kind: "bookmark",
					isReplied: false,
					replyToTweet: null,
					quotedTweet: null,
				}}
				onReply={onReply}
				showReplyControls={false}
			/>,
		);

		expect(queries.queryByText("needs reply")).not.toBeInTheDocument();
		expect(
			queries.queryByRole("button", { name: "Reply" }),
		).not.toBeInTheDocument();
		expect(onReply).not.toHaveBeenCalled();
	});

	it("filters quoted tweet urls and falls back to display urls in previews", () => {
		render(
			<TimelineCard
				item={{
					...item,
					id: "tweet_3",
					entities: {
						urls: [
							{
								url: "https://t.co/quote",
								expandedUrl: "https://x.com/ava/status/tweet_q",
								displayUrl: "x.com/ava/status/tweet_q",
								start: 0,
								end: 10,
							},
							{
								url: "https://t.co/kept",
								expandedUrl: "https://example.com/kept",
								displayUrl: "example.com/kept",
								start: 11,
								end: 20,
							},
						],
					},
					replyToTweet: null,
					media: [],
					mediaCount: 0,
				}}
				onReply={vi.fn()}
			/>,
		);

		expect(
			screen.getByRole("link", { name: "example.com/kept" }),
		).toBeInTheDocument();
		expect(screen.getAllByText("example.com/kept").length).toBeGreaterThan(1);
	});

	it("renders direct image URL cards with the image immediately", () => {
		render(
			<TimelineCard
				item={{
					...item,
					id: "tweet_4",
					text: "@steipete https://t.co/image",
					entities: {
						urls: [
							{
								url: "https://t.co/image",
								expandedUrl: "https://pbs.twimg.com/media/HIB4bvDXQAAUcO8.png",
								displayUrl: "t.co/image",
								start: 10,
								end: 28,
							},
						],
					},
					replyToTweet: null,
					quotedTweet: null,
					media: [],
					mediaCount: 1,
				}}
				onReply={vi.fn()}
			/>,
		);

		expect(screen.getByRole("img", { name: "pbs.twimg.com" })).toHaveAttribute(
			"src",
			"https://pbs.twimg.com/media/HIB4bvDXQAAUcO8.png",
		);
		expect(screen.getAllByText("pbs.twimg.com").length).toBeGreaterThan(0);
	});

	it("does not duplicate media URLs as text links or preview cards", () => {
		render(
			<TimelineCard
				item={{
					...item,
					id: "tweet_5",
					text: "Screenshot https://t.co/image",
					entities: {
						urls: [
							{
								url: "https://t.co/image",
								expandedUrl: "https://pbs.twimg.com/media/HIB4bvDXQAAUcO8.png",
								displayUrl: "t.co/image",
								start: 11,
								end: 29,
							},
						],
					},
					media: [
						{
							url: "https://pbs.twimg.com/media/HIB4bvDXQAAUcO8.png?format=png&name=large",
							type: "image",
							altText: "Screenshot",
							width: 1200,
							height: 900,
						},
					],
					mediaCount: 1,
					replyToTweet: null,
					quotedTweet: null,
				}}
				onReply={vi.fn()}
			/>,
		);

		expect(screen.getByText("Screenshot")).toBeInTheDocument();
		expect(screen.getByAltText("Screenshot")).toBeInTheDocument();
		expect(screen.queryByText("t.co/image")).not.toBeInTheDocument();
		expect(screen.queryByText("pbs.twimg.com")).not.toBeInTheDocument();
		expect(screen.queryByRole("link", { name: /t\.co\/image/ })).toBeNull();
	});

	it("does not duplicate pic.twitter.com media URLs as text links or preview cards", () => {
		render(
			<TimelineCard
				item={{
					...item,
					id: "tweet_6",
					text: "Photo https://t.co/pic",
					entities: {
						urls: [
							{
								url: "https://t.co/pic",
								expandedUrl: "https://x.com/ava/status/tweet_6/photo/1",
								displayUrl: "pic.twitter.com/demo",
								start: 6,
								end: 22,
							},
						],
					},
					media: [
						{
							url: "https://pbs.twimg.com/media/demo.jpg",
							type: "image",
							altText: "Photo media",
						},
					],
					mediaCount: 1,
					replyToTweet: null,
					quotedTweet: null,
				}}
				onReply={vi.fn()}
			/>,
		);

		expect(screen.getByText("Photo")).toBeInTheDocument();
		expect(screen.getByAltText("Photo media")).toBeInTheDocument();
		expect(screen.queryByText("pic.twitter.com/demo")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("link", { name: /pic\.twitter\.com/ }),
		).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Open tweet media 1" }));
		expect(screen.queryByText("pic.twitter.com/demo")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("link", { name: /pic\.twitter\.com/ }),
		).toBeNull();
	});

	it("hides unresolved t.co text and preview cards when media is attached", () => {
		render(
			<TimelineCard
				item={{
					...item,
					id: "tweet_short_media",
					text: "t.co/QbCcJuNZjo",
					entities: {
						urls: [
							{
								url: "https://t.co/QbCcJuNZjo",
								expandedUrl: "https://t.co/QbCcJuNZjo",
								displayUrl: "t.co/QbCcJuNZjo",
								start: 0,
								end: 15,
							},
						],
					},
					media: [
						{
							url: "https://pbs.twimg.com/media/tall.jpg",
							type: "image",
							altText: "Tall screenshot",
							width: 768,
							height: 1600,
						},
					],
					mediaCount: 1,
					replyToTweet: null,
					quotedTweet: null,
				}}
				onReply={vi.fn()}
			/>,
		);

		expect(screen.getByAltText("Tall screenshot")).toBeInTheDocument();
		expect(screen.queryByText("t.co/QbCcJuNZjo")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("link", { name: /t\.co\/QbCcJuNZjo/ }),
		).toBeNull();
	});

	it("keeps unresolved t.co links when the media tweet has other text", () => {
		render(
			<TimelineCard
				item={{
					...item,
					id: "tweet_short_media_caption",
					text: "Read this https://t.co/article",
					entities: {
						urls: [
							{
								url: "https://t.co/article",
								expandedUrl: "https://t.co/article",
								displayUrl: "t.co/article",
								start: 10,
								end: 30,
							},
						],
					},
					media: [
						{
							url: "https://pbs.twimg.com/media/article-card.jpg",
							type: "image",
							altText: "Article image",
						},
					],
					mediaCount: 1,
					replyToTweet: null,
					quotedTweet: null,
				}}
				onReply={vi.fn()}
			/>,
		);

		expect(screen.getByText("Read this")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "t.co/article" })).toHaveAttribute(
			"href",
			"https://t.co/article",
		);
		expect(screen.getByAltText("Article image")).toBeInTheDocument();
	});

	it("does not render placeholder preview cards for unresolved t.co links", () => {
		render(
			<TimelineCard
				item={{
					...item,
					id: "tweet_unresolved_link",
					text: "He can't stop\n\nhttps://t.co/1b11HHQIBA",
					entities: {
						urls: [
							{
								url: "https://t.co/1b11HHQIBA",
								expandedUrl: "https://t.co/1b11HHQIBA",
								displayUrl: "t.co/1b11HHQIBA",
								start: 15,
								end: 38,
							},
						],
					},
					media: [],
					mediaCount: 0,
					replyToTweet: null,
					quotedTweet: null,
				}}
				onReply={vi.fn()}
			/>,
		);

		expect(
			screen.getByRole("link", { name: "t.co/1b11HHQIBA" }),
		).toHaveAttribute("href", "https://t.co/1b11HHQIBA");
		expect(
			document.querySelector("[data-perf='link-preview-card']"),
		).toBeNull();
	});

	it("expands Twitter Articles and hides their shortlinks", () => {
		const { container } = render(
			<TimelineCard
				item={{
					...item,
					id: "2066182223213293753",
					text: "A frontier without an ecosystem is not stable",
					entities: {
						urls: [
							{
								url: "https://t.co/vLmiBKTtX3",
								expandedUrl: "https://x.com/i/article/2065582894790365184",
								displayUrl: "x.com/i/article/2065…",
								start: 0,
								end: 0,
							},
						],
						article: {
							title: "A frontier without an ecosystem is not stable",
							previewText: "I have been thinking about the future of the firm.",
							url: "https://x.com/satyanadella/status/2066182223213293753",
						},
					},
					media: [],
					mediaCount: 0,
					replyToTweet: null,
					quotedTweet: null,
				}}
				onReply={vi.fn()}
			/>,
		);

		expect(
			screen.getByRole("link", {
				name: "Read article: A frontier without an ecosystem is not stable",
			}),
		).toHaveAttribute(
			"href",
			"https://x.com/satyanadella/status/2066182223213293753",
		);
		expect(
			screen.getByText("I have been thinking about the future of the firm."),
		).toBeInTheDocument();
		expect(
			screen.getAllByText("A frontier without an ecosystem is not stable"),
		).toHaveLength(1);
		expect(screen.queryByText(/t\.co\/vLmiBKTtX3/)).toBeNull();
		expect(
			container.querySelectorAll("[data-perf='tweet-article-card']"),
		).toHaveLength(1);
		expect(
			container.querySelector("[data-perf='link-preview-card']"),
		).toBeNull();
	});

	it("tolerates archived media URL entities without display URLs", () => {
		render(
			<TimelineCard
				item={{
					...item,
					id: "tweet_missing_display_url",
					text: "Photo https://t.co/pic",
					entities: {
						urls: [
							{
								url: "https://t.co/pic",
								expandedUrl:
									"https://x.com/ava/status/tweet_missing_display_url/photo/1",
								displayUrl: undefined as unknown as string,
								start: 6,
								end: 22,
							},
						],
					},
					media: [
						{
							url: "https://pbs.twimg.com/media/missing-display.jpg",
							type: "image",
							altText: "Archived media",
						},
					],
					mediaCount: 1,
					replyToTweet: null,
					quotedTweet: null,
				}}
				onReply={vi.fn()}
			/>,
		);

		expect(screen.getByText("Photo")).toBeInTheDocument();
		expect(screen.getByAltText("Archived media")).toBeInTheDocument();
		expect(screen.queryByText("undefined")).not.toBeInTheDocument();
		expect(screen.queryByRole("link", { name: /x\.com\/ava/ })).toBeNull();
	});

	it("keeps self-permalink URL entities on media tweets", () => {
		render(
			<TimelineCard
				item={{
					...item,
					id: "tweet_self_permalink",
					text: "Thread https://t.co/self",
					entities: {
						urls: [
							{
								url: "https://t.co/self",
								expandedUrl: "https://x.com/ava/status/tweet_self_permalink",
								displayUrl: "x.com/ava/status/tweet_self_permalink",
								start: 7,
								end: 24,
							},
						],
					},
					media: [
						{
							url: "https://pbs.twimg.com/media/self-permalink.jpg",
							type: "image",
							altText: "Attached media",
						},
					],
					mediaCount: 1,
					replyToTweet: null,
					quotedTweet: null,
				}}
				onReply={vi.fn()}
			/>,
		);

		expect(screen.getByAltText("Attached media")).toBeInTheDocument();
		expect(
			screen.getAllByRole("link", {
				name: /x\.com\/ava\/status\/tweet_self_permalink/,
			}).length,
		).toBeGreaterThan(0);
	});

	it("keeps external status media links when the tweet has its own media", () => {
		render(
			<TimelineCard
				item={{
					...item,
					id: "tweet_7",
					text: "Look https://t.co/other https://t.co/pic2",
					entities: {
						urls: [
							{
								url: "https://t.co/other",
								expandedUrl: "https://x.com/other/status/123/photo/1",
								displayUrl: "x.com/other/status/123/photo/1",
								start: 5,
								end: 23,
							},
							{
								url: "https://t.co/pic2",
								expandedUrl: "https://x.com/other/status/456/photo/1",
								displayUrl: "pic.twitter.com/other",
								start: 24,
								end: 41,
							},
						],
					},
					media: [
						{
							url: "https://pbs.twimg.com/media/own.jpg",
							type: "image",
							altText: "Own media",
						},
					],
					mediaCount: 1,
					replyToTweet: null,
					quotedTweet: null,
				}}
				onReply={vi.fn()}
			/>,
		);

		expect(screen.getByAltText("Own media")).toBeInTheDocument();
		expect(
			screen.getAllByRole("link", { name: /x\.com\/other\/status\/123/ }),
		).toHaveLength(2);
		expect(
			screen.getByRole("link", { name: "pic.twitter.com/other" }),
		).toHaveAttribute("href", "https://x.com/other/status/456/photo/1");
	});

	it("does not toggle conversation when closing the media viewer backdrop", () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		render(
			<TimelineCard
				item={{
					...item,
					id: "tweet_8",
					entities: {},
					media: [
						{
							url: "https://example.com/demo.jpg",
							type: "image",
							altText: "Demo image",
						},
					],
					replyToTweet: null,
					quotedTweet: null,
				}}
				onReply={vi.fn()}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Open tweet media 1" }));
		const details = document.querySelector('aside[aria-label="Tweet details"]');
		expect(details).toHaveTextContent("Sam Altman");
		expect(details).toHaveTextContent("Ship with @sam");
		expect(
			screen.getByRole("link", { name: "Open @sam on X" }),
		).toHaveAttribute("href", "https://x.com/sam/status/tweet_8");
		fireEvent.click(details!);
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("dialog"));

		expect(fetchMock).not.toHaveBeenCalled();
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("does not toggle the conversation when inline video controls are used", () => {
		const fetchMock = vi.fn();
		const play = vi
			.spyOn(HTMLMediaElement.prototype, "play")
			.mockResolvedValue();
		vi.stubGlobal("fetch", fetchMock);
		render(
			<TimelineCard
				item={{
					...item,
					id: "tweet_video",
					entities: {},
					media: [
						{
							url: "https://pbs.twimg.com/video-thumb.jpg",
							type: "video",
							thumbnailUrl: "https://pbs.twimg.com/video-thumb.jpg",
							variants: [
								{
									url: "https://video.twimg.com/ext_tw_video/clip.mp4",
									contentType: "video/mp4",
								},
							],
						},
					],
					replyToTweet: null,
					quotedTweet: null,
				}}
				onReply={vi.fn()}
			/>,
		);

		fireEvent.click(screen.getByLabelText("Play tweet video 1"));

		expect(play).toHaveBeenCalledOnce();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("expands the archived conversation when the tweet row is clicked", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				ok: true,
				anchorId: "tweet_1",
				items: [
					{
						id: "tweet_parent",
						text: "Parent in thread",
						createdAt: "2026-03-08T11:30:00.000Z",
						replyToId: null,
						author: item.author,
						entities: {},
						media: [],
					},
					{
						id: "tweet_1",
						text: "Clicked tweet in thread",
						createdAt: "2026-03-08T12:00:00.000Z",
						replyToId: "tweet_parent",
						author: item.author,
						entities: {},
						media: [],
					},
				],
			}),
		});
		vi.stubGlobal("fetch", fetchMock);
		const { container } = render(
			<TimelineCard item={item} onReply={vi.fn()} />,
		);
		const row = container.querySelector("[data-perf='timeline-card']");
		if (!row) throw new Error("timeline card missing");

		fireEvent.click(row);

		expect(fetchMock).toHaveBeenCalledWith("/api/conversation?tweetId=tweet_1");
		expect(await screen.findByText("Parent in thread")).toBeInTheDocument();
		expect(screen.getByText("2 tweets in conversation")).toBeInTheDocument();
		expect(screen.getByText("selected")).toBeInTheDocument();
	});

	it("prefetches conversation context on hover and keeps one thread open", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const tweetId = new URL(
				String(input),
				"http://localhost",
			).searchParams.get("tweetId");
			return {
				ok: true,
				json: async () => ({
					ok: true,
					anchorId: tweetId,
					items: [
						{
							id: tweetId,
							text: `Conversation for ${tweetId}`,
							createdAt: "2026-03-08T12:00:00.000Z",
							replyToId: null,
							author: item.author,
							entities: {},
							media: [],
						},
						{
							id: `${tweetId}_reply`,
							text: `Reply for ${tweetId}`,
							createdAt: "2026-03-08T12:01:00.000Z",
							replyToId: tweetId,
							author: item.author,
							entities: {},
							media: [],
						},
					],
				}),
			};
		});
		vi.stubGlobal("fetch", fetchMock);
		const { container } = render(
			<>
				<TimelineCard item={{ ...item, id: "tweet_a" }} onReply={vi.fn()} />
				<TimelineCard item={{ ...item, id: "tweet_b" }} onReply={vi.fn()} />
			</>,
		);
		const rows = container.querySelectorAll("[data-perf='timeline-card']");
		const first = rows[0];
		const second = rows[1];
		if (!first || !second) throw new Error("timeline cards missing");

		fireEvent.mouseEnter(first);
		expect(fetchMock).toHaveBeenCalledWith("/api/conversation?tweetId=tweet_a");

		fireEvent.click(first);
		expect(
			await screen.findByText("Conversation for tweet_a"),
		).toBeInTheDocument();

		fireEvent.click(second);
		expect(
			await screen.findByText("Conversation for tweet_b"),
		).toBeInTheDocument();
		expect(
			screen.queryByText("Conversation for tweet_a"),
		).not.toBeInTheDocument();
	});
});
