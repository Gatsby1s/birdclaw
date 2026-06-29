import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithQueryClient as render } from "#/test/render";
import { Route } from "./settings";

const SettingsRoute = Route.options.component as ComponentType;

function settingsPayload(profileSource: "local" | "xurl" | "6551") {
	return {
		analysis: { profileSource },
		providers: {
			twitter6551: {
				baseUrl: "https://ai.6551.io",
				tokenEnv: "TWITTER_TOKEN",
				tokenDetected: false,
			},
		},
	};
}

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("settings route", () => {
	it("updates the global profile analysis source", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(Response.json(settingsPayload("local")))
			.mockResolvedValueOnce(Response.json(settingsPayload("xurl")));
		vi.stubGlobal("fetch", fetchMock);

		render(<SettingsRoute />);

		expect(
			await screen.findByText("Profile Analyse Source"),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Local" })).toBeDisabled();

		fireEvent.click(screen.getByRole("button", { name: "XURL refresh" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(
				"/api/settings",
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({ analysis: { profileSource: "xurl" } }),
				}),
			);
		});
		expect(
			await screen.findByRole("button", { name: "XURL refresh" }),
		).toBeDisabled();
	});
});
