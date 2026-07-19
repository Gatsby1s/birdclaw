import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DiscussHistoryPanel,
	type DiscussHistoryListItem,
} from "./DiscussHistoryPanel";

function historyItem(
	id: string,
	overrides: Partial<DiscussHistoryListItem> = {},
): DiscussHistoryListItem {
	return {
		id,
		title: `Topic ${id}`,
		summary: `Saved discussion summary for ${id}`,
		query: id,
		source: "all",
		mode: "auto",
		range: "all",
		includeDms: false,
		themeTitles: ["Storage", "Reliability"],
		sourceCount: 12,
		dmCount: 0,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		parentId: null,
		pinned: false,
		versionCount: 1,
		...overrides,
	};
}

describe("DiscussHistoryPanel", () => {
	afterEach(cleanup);

	it("groups saved discussions and exposes restore, pin, and delete actions", () => {
		const yesterday = new Date();
		yesterday.setDate(yesterday.getDate() - 1);
		const onSelect = vi.fn();
		const onDelete = vi.fn();
		const onTogglePin = vi.fn();
		const items = [
			historyItem("today", { title: "Local storage", dmCount: 3 }),
			historyItem("yesterday", {
				title: "Archive design",
				createdAt: yesterday.toISOString(),
				versionCount: 2,
			}),
		];

		render(
			<DiscussHistoryPanel
				items={items}
				activeId="today"
				loading={false}
				error={null}
				filter=""
				onFilterChange={() => undefined}
				onSelect={onSelect}
				onDelete={onDelete}
				onTogglePin={onTogglePin}
			/>,
		);

		expect(screen.getByRole("heading", { name: "Today" })).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { name: "Yesterday" }),
		).toBeInTheDocument();
		expect(screen.getByText("3")).toBeInTheDocument();
		expect(screen.getByText("2 versions")).toBeInTheDocument();

		const activeRow = screen
			.getByRole("heading", { name: "Local storage" })
			.closest("article");
		expect(activeRow).not.toBeNull();
		fireEvent.click(
			within(activeRow as HTMLElement).getByRole("button", { pressed: true }),
		);
		expect(onSelect).toHaveBeenCalledWith("today");

		fireEvent.click(screen.getByRole("button", { name: "Pin Local storage" }));
		expect(onTogglePin).toHaveBeenCalledWith(items[0]);
		fireEvent.click(
			screen.getByRole("button", { name: "Delete Archive design" }),
		);
		expect(onDelete).toHaveBeenCalledWith("yesterday");
	});

	it("filters by title, query, summary, and theme without hiding the search box", () => {
		const onFilterChange = vi.fn();
		render(
			<DiscussHistoryPanel
				items={[
					historyItem("one", { title: "Storage systems" }),
					historyItem("two", {
						title: "Model releases",
						themeTitles: ["OpenAI"],
					}),
				]}
				activeId=""
				loading={false}
				error={null}
				filter="OpenAI"
				onFilterChange={onFilterChange}
				onSelect={() => undefined}
				onDelete={() => undefined}
				onTogglePin={() => undefined}
			/>,
		);

		expect(screen.getByText("Model releases")).toBeInTheDocument();
		expect(screen.queryByText("Storage systems")).toBeNull();
		fireEvent.change(screen.getByLabelText("Search discussion history"), {
			target: { value: "storage" },
		});
		expect(onFilterChange).toHaveBeenCalledWith("storage");
	});
});
