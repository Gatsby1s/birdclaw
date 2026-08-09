import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithQueryClient as render } from "#/test/render";
import { Route } from "./data-sources";

const DataSourcesRoute = Route.options.component as ComponentType;

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function payload() {
	return {
		generatedAt: "2026-08-10T00:00:00.000Z",
		sources: [
			{
				source: "birdclaw",
				label: "BirdClaw local",
				works: true,
				installed: true,
				status: "ok",
				detail: "archive ready",
				accounts: [{ id: "1", handle: "@owner", isDefault: true }, { id: "2" }],
			},
			{
				source: "bird",
				label: "bird",
				works: false,
				installed: false,
				status: "warning",
				detail: "missing",
				accounts: [],
			},
			{
				source: "xurl",
				label: "xurl",
				works: false,
				installed: true,
				status: "warning",
				detail: "standby",
				accounts: [{ app: "oauth", username: "xurl_user" }],
			},
			{
				source: "twitter6551",
				label: "6551 Twitter API",
				works: false,
				installed: true,
				status: "error",
				detail: "token rejected",
				accounts: [],
			},
		],
		capabilities: [
			{
				key: "profile-analysis",
				label: "Profile Analyse",
				primary: "twitter6551",
				fallbacks: ["xurl", "birdclaw"],
				notes: "Explicit refresh order",
			},
			{
				key: "timeline",
				label: "Home timeline",
				primary: "xurl",
				fallbacks: ["bird"],
			},
		],
	};
}

describe("data sources route", () => {
	it("renders source health, accounts, and fallback chains and refreshes", async () => {
		const fetchMock = vi.fn(async () => Response.json(payload()));
		vi.stubGlobal("fetch", fetchMock);
		render(<DataSourcesRoute />);

		expect(await screen.findByText("BirdClaw local")).toBeVisible();
		expect(screen.getByText("not installed")).toBeVisible();
		expect(screen.getByText("@owner")).toBeVisible();
		expect(screen.getByText("default")).toBeVisible();
		expect(screen.getByText("oauth")).toBeVisible();
		expect(screen.getByText("@xurl_user")).toBeVisible();
		expect(screen.getByText("Profile Analyse")).toBeVisible();
		expect(screen.getByText("Explicit refresh order")).toBeVisible();
		expect(screen.getByText("6551")).toBeVisible();
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
	});

	it("shows a request error without inventing a stale snapshot", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
		render(<DataSourcesRoute />);
		expect(await screen.findByText("offline")).toBeVisible();
		expect(screen.queryByText("Fallbacks")).not.toBeInTheDocument();
	});
});
