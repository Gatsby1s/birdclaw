// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const listDiscussionHistoryMock = vi.fn();
const getDiscussionHistoryMock = vi.fn();
const deleteDiscussionHistoryMock = vi.fn();
const updateDiscussionHistoryMock = vi.fn();

vi.mock("#/lib/discussion-history", () => ({
	listDiscussionHistory: (...args: unknown[]) =>
		listDiscussionHistoryMock(...args),
	getDiscussionHistory: (...args: unknown[]) =>
		getDiscussionHistoryMock(...args),
	deleteDiscussionHistory: (...args: unknown[]) =>
		deleteDiscussionHistoryMock(...args),
	updateDiscussionHistory: (...args: unknown[]) =>
		updateDiscussionHistoryMock(...args),
}));

import { Route } from "./discussion-history";

type HistoryMethod = "GET" | "DELETE" | "PATCH";
type HistoryHandler = (context: { request: Request }) => Promise<Response>;

function routeHandler(method: HistoryMethod) {
	const handlers = Route.options.server?.handlers as unknown as Record<
		HistoryMethod,
		HistoryHandler
	>;
	return handlers[method];
}

const GET = routeHandler("GET");
const DELETE = routeHandler("DELETE");
const PATCH = routeHandler("PATCH");

describe("api discussion history route", () => {
	beforeEach(() => {
		listDiscussionHistoryMock.mockReset();
		getDiscussionHistoryMock.mockReset();
		deleteDiscussionHistoryMock.mockReset();
		updateDiscussionHistoryMock.mockReset();
	});

	it("lists lightweight history metadata with a bounded limit", async () => {
		listDiscussionHistoryMock.mockReturnValue([{ id: "history_1" }]);
		const response = await GET({
			request: new Request(
				"http://localhost/api/discussion-history?limit=5000",
			),
		});

		expect(listDiscussionHistoryMock).toHaveBeenCalledWith({ limit: 200 });
		expect(await response.json()).toEqual({ items: [{ id: "history_1" }] });
	});

	it("returns one restorable history detail", async () => {
		getDiscussionHistoryMock.mockReturnValue({
			metadata: { id: "history_1" },
			result: { markdown: "# Restored", historyId: "history_1" },
		});
		const response = await GET({
			request: new Request(
				"http://localhost/api/discussion-history?id=history_1",
			),
		});

		expect(getDiscussionHistoryMock).toHaveBeenCalledWith("history_1");
		expect(await response.json()).toEqual({
			item: expect.objectContaining({
				result: expect.objectContaining({ historyId: "history_1" }),
			}),
		});
	});

	it("soft deletes a history item", async () => {
		deleteDiscussionHistoryMock.mockReturnValue(true);
		const response = await DELETE({
			request: new Request(
				"http://localhost/api/discussion-history?id=history_1",
				{ method: "DELETE" },
			),
		});

		expect(deleteDiscussionHistoryMock).toHaveBeenCalledWith("history_1");
		expect(await response.json()).toEqual({ ok: true });
	});

	it("renames and pins a history item", async () => {
		updateDiscussionHistoryMock.mockReturnValue({
			id: "history_1",
			title: "Renamed",
			pinned: true,
		});
		const response = await PATCH({
			request: new Request("http://localhost/api/discussion-history", {
				method: "PATCH",
				body: JSON.stringify({
					id: "history_1",
					title: " Renamed ",
					pinned: true,
				}),
			}),
		});

		expect(updateDiscussionHistoryMock).toHaveBeenCalledWith("history_1", {
			title: "Renamed",
			pinned: true,
		});
		expect(await response.json()).toEqual({
			item: expect.objectContaining({ title: "Renamed", pinned: true }),
		});
	});

	it("returns clear errors for missing ids and missing items", async () => {
		getDiscussionHistoryMock.mockReturnValue(null);
		deleteDiscussionHistoryMock.mockReturnValue(false);

		const missingId = await DELETE({
			request: new Request("http://localhost/api/discussion-history", {
				method: "DELETE",
			}),
		});
		const missingItem = await GET({
			request: new Request(
				"http://localhost/api/discussion-history?id=missing",
			),
		});

		expect(missingId.status).toBe(400);
		expect(missingItem.status).toBe(404);
	});
});
