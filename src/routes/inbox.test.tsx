import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQueryClient as render } from "#/test/render";

vi.mock("#/components/InboxCard", () => ({
	InboxCard: ({
		item,
		isReplying,
		replyDraft,
		onReplyToggle,
		onReplyChange,
		onReplySend,
	}: {
		item: { title: string; id: string };
		isReplying: boolean;
		replyDraft: string;
		onReplyToggle: () => void;
		onReplyChange: (value: string) => void;
		onReplySend: () => void;
	}) => (
		<div>
			<button onClick={onReplyToggle} type="button">
				{item.title}
			</button>
			{isReplying ? (
				<div>
					<input
						aria-label={`Reply ${item.id}`}
						onChange={(event) => onReplyChange(event.target.value)}
						value={replyDraft}
					/>
					<button onClick={onReplySend} type="button">
						Send {item.title}
					</button>
				</div>
			) : null}
		</div>
	),
}));

import { InboxRouteView as InboxRoute } from "./inbox";

afterEach(() => {
	cleanup();
});

describe("inbox route", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("loads inbox items and triggers scoring", async () => {
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
				if (url.includes("/api/inbox")) {
					return new Response(
						JSON.stringify({
							items: [
								{
									id: "dm:dm_1",
									title: "DM from Sam Altman",
								},
							],
							stats: {
								total: 1,
								openai: 0,
								heuristic: 1,
							},
						}),
					);
				}
				if (url.endsWith("/api/action") && init?.method === "POST") {
					return new Response(JSON.stringify({ ok: true }));
				}
				throw new Error(`Unexpected fetch ${url}`);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		render(<InboxRoute />);

		expect(await screen.findByText("DM from Sam Altman")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Score with OpenAI" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(
				"/api/action",
				expect.objectContaining({ method: "POST" }),
			);
		});
	});

	it("sends tweet replies from the inbox composer", async () => {
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
				if (url.includes("/api/inbox")) {
					return new Response(
						JSON.stringify({
							items: [
								{
									id: "mention:tweet_1",
									entityId: "tweet_1",
									entityKind: "mention",
									accountId: "acct_primary",
									title: "Mention from Amelia",
								},
							],
							stats: {
								total: 1,
								openai: 0,
								heuristic: 1,
							},
						}),
					);
				}
				if (url.endsWith("/api/action") && init?.method === "POST") {
					return new Response(JSON.stringify({ ok: true }));
				}
				throw new Error(`Unexpected fetch ${url}`);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		render(<InboxRoute />);

		expect(await screen.findByText("Mention from Amelia")).toBeInTheDocument();
		const [mentionButton] = screen.getAllByRole("button", {
			name: "Mention from Amelia",
		});
		if (!mentionButton) {
			throw new Error("Missing mention button");
		}
		fireEvent.click(mentionButton);
		fireEvent.change(screen.getByLabelText("Reply mention:tweet_1"), {
			target: { value: "Will reply from here." },
		});
		fireEvent.click(
			screen.getByRole("button", { name: "Send Mention from Amelia" }),
		);

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(
				"/api/action",
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({
						kind: "replyTweet",
						accountId: "acct_primary",
						tweetId: "tweet_1",
						text: "Will reply from here.",
					}),
				}),
			);
		});
	});

	it("keeps the inbox reply draft when transport fails", async () => {
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
				if (url.includes("/api/inbox")) {
					return new Response(
						JSON.stringify({
							items: [
								{
									id: "mention:tweet_1",
									entityId: "tweet_1",
									entityKind: "mention",
									accountId: "acct_primary",
									title: "Mention from Amelia",
								},
							],
							stats: {
								total: 1,
								openai: 0,
								heuristic: 1,
							},
						}),
					);
				}
				if (url.endsWith("/api/action") && init?.method === "POST") {
					return new Response(JSON.stringify({ message: "transport down" }), {
						status: 500,
					});
				}
				throw new Error(`Unexpected fetch ${url}`);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		render(<InboxRoute />);

		expect(await screen.findByText("Mention from Amelia")).toBeInTheDocument();
		fireEvent.click(
			screen.getByRole("button", { name: "Mention from Amelia" }),
		);
		fireEvent.change(screen.getByLabelText("Reply mention:tweet_1"), {
			target: { value: "Please do not drop this." },
		});
		fireEvent.click(
			screen.getByRole("button", { name: "Send Mention from Amelia" }),
		);

		expect(await screen.findByText("transport down")).toBeInTheDocument();
		expect(
			(screen.getByLabelText("Reply mention:tweet_1") as HTMLInputElement)
				.value,
		).toBe("Please do not drop this.");

		fireEvent.click(
			screen.getByRole("button", { name: "Mention from Amelia" }),
		);

		await waitFor(() => {
			expect(screen.queryByText("transport down")).toBeNull();
		});
	});
});
