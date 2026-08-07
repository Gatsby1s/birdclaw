import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithQueryClient as render } from "#/test/render";
import { ProfileSpecialFollowButton } from "./ProfileSpecialFollowButton";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("ProfileSpecialFollowButton", () => {
	it("toggles the independent Today priority with accessible state", async () => {
		let specialFollow = false;
		let patchBody: Record<string, unknown> | null = null;
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(String(input), "http://localhost");
				expect(url.pathname).toBe("/api/profile-priority");
				if (init?.method === "PATCH") {
					patchBody = JSON.parse(String(init.body)) as Record<string, unknown>;
					specialFollow = Boolean(patchBody.specialFollow);
				}
				return Response.json({
					handle: "ada",
					identifier: "42",
					specialFollow,
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		render(
			<ProfileSpecialFollowButton handle="Ada" identifier="profile_user_42" />,
		);
		const button = await screen.findByRole("button", {
			name: "Special follow",
		});
		expect(button).toHaveAttribute("aria-pressed", "false");
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		fireEvent.click(screen.getByRole("button", { name: "Special follow" }));

		await waitFor(() => expect(patchBody).not.toBeNull());
		expect(patchBody).toEqual({
			handle: "Ada",
			identifier: "profile_user_42",
			specialFollow: true,
		});
		expect(
			await screen.findByRole("button", { name: "Special following" }),
		).toHaveAttribute("aria-pressed", "true");
	});
});
