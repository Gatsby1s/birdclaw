import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeedItem } from "#/lib/api-contracts";
import { renderWithQueryClient as render } from "#/test/render";
import { FeedItemCard } from "./feed";

const article: FeedItem = {
	id: "tiger:article:1234567890",
	source: "tiger",
	externalId: "1234567890",
	kind: "article",
	title: "A full article",
	summary: "Short excerpt",
	url: "https://www.laohu8.com/news/1234567890",
	publisher: "Tiger News",
	publishedAt: "2026-08-18T08:00:00.000Z",
	market: "us",
	language: "zh-CN",
	symbols: ["AAPL"],
	imageUrl: null,
	isImportant: false,
	updatedAt: "2026-08-18T09:00:00.000Z",
};

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("feed article card", () => {
	it("loads the full text only after expansion and keeps the source link", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			Response.json({
				ok: true,
				item: article,
				content: "First paragraph.\n\nA material detail beyond the excerpt.",
				contentHash: "a".repeat(64),
				cached: true,
				fetchedAt: "2026-08-18T09:00:00.000Z",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		render(<FeedItemCard item={article} />);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(screen.getByRole("link", { name: /打开老虎原文/ })).toHaveAttribute(
			"href",
			article.url,
		);

		fireEvent.click(screen.getByRole("button", { name: "阅读正文" }));
		expect(
			await screen.findByText(/A material detail beyond the excerpt/),
		).toBeVisible();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
			"id=tiger%3Aarticle%3A1234567890",
		);
		fireEvent.click(screen.getByRole("button", { name: "收起正文" }));
		expect(
			screen.queryByText(/A material detail beyond the excerpt/),
		).not.toBeInTheDocument();
	});

	it("shows a safe fallback without exposing upstream errors", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					new Response("secret upstream response", { status: 502 }),
				),
		);
		render(<FeedItemCard item={article} />);
		fireEvent.click(screen.getByRole("button", { name: "阅读正文" }));
		expect(
			await screen.findByText(
				"正文暂时读取失败，可先打开老虎原文查看。",
				{},
				{ timeout: 3_000 },
			),
		).toBeVisible();
		expect(screen.queryByText(/secret upstream/)).not.toBeInTheDocument();
	});
});
