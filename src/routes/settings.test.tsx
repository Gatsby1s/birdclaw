import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "#/lib/query-client";
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
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/xremark") {
					return Response.json({
						imported: false,
						annotationCount: 0,
						matchedProfileCount: 0,
					});
				}
				if (url.pathname === "/api/integrations/xremark") {
					return Response.json({
						paired: false,
						connected: false,
						extensionId: "imbbpjelfehedmikmbjglhpoiehpjjhl",
						endpoint: "http://127.0.0.1:3001/api/integrations/xremark/snapshot",
						lastSequence: 0,
					});
				}
				return Response.json(
					settingsPayload(init?.method === "POST" ? "xurl" : "local"),
				);
			},
		);
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

	it("imports an X Remark JSON backup from settings", async () => {
		const importedStatus = {
			imported: true,
			annotationCount: 2,
			matchedProfileCount: 1,
			backupId: "backup_settings",
			importedAt: "2026-07-19T12:00:00.000Z",
			sourceVersion: 1,
		};
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/settings") {
					return Response.json(settingsPayload("local"));
				}
				if (url.pathname === "/api/integrations/xremark") {
					return Response.json({
						paired: false,
						connected: false,
						extensionId: "imbbpjelfehedmikmbjglhpoiehpjjhl",
						endpoint: "http://127.0.0.1:3001/api/integrations/xremark/snapshot",
						lastSequence: 0,
					});
				}
				return Response.json(
					init?.method === "POST"
						? importedStatus
						: {
								imported: false,
								annotationCount: 0,
								matchedProfileCount: 0,
							},
				);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		const { container } = render(<SettingsRoute />);
		expect(await screen.findByText("X Remark Notes")).toBeInTheDocument();
		const input = container.querySelector('input[type="file"]');
		expect(input).not.toBeNull();
		const backupJson = JSON.stringify({
			database: {
				name: "xRemark",
				version: 1,
				backupID: "backup_settings",
				backupTime: 1,
			},
			remarks: [],
		});
		fireEvent.change(input as HTMLInputElement, {
			target: {
				files: [
					{
						name: "XRemark_Backup_Data_test.json",
						size: backupJson.length,
						text: () => Promise.resolve(backupJson),
					},
				],
			},
		});

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(
				"/api/xremark",
				expect.objectContaining({
					method: "POST",
					body: backupJson,
				}),
			);
		});
		expect(
			await screen.findByText(
				"2 notes imported · 1 matched to BirdClaw profiles",
			),
		).toBeInTheDocument();
	});

	it("creates a live-sync pairing token without removing manual import", async () => {
		let liveStatusReads = 0;
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/settings") {
					return Response.json(settingsPayload("local"));
				}
				if (url.pathname === "/api/xremark") {
					return Response.json({
						imported: false,
						annotationCount: 0,
						matchedProfileCount: 0,
					});
				}
				if (url.pathname === "/api/integrations/xremark") {
					if (init?.method === "POST") {
						return Response.json({
							paired: true,
							connected: false,
							extensionId: "imbbpjelfehedmikmbjglhpoiehpjjhl",
							endpoint:
								"http://127.0.0.1:3001/api/integrations/xremark/snapshot",
							lastSequence: 0,
							token: "a".repeat(43),
						});
					}
					liveStatusReads += 1;
					return Response.json({
						paired: liveStatusReads > 1,
						connected: liveStatusReads > 1,
						extensionId: "imbbpjelfehedmikmbjglhpoiehpjjhl",
						endpoint: "http://127.0.0.1:3001/api/integrations/xremark/snapshot",
						lastSequence: liveStatusReads > 1 ? 1 : 0,
						...(liveStatusReads > 1
							? { lastSeenAt: "2026-07-19T12:00:00.000Z" }
							: {}),
					});
				}
				throw new Error(`Unexpected URL: ${url.pathname}`);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		const { queryClient } = render(<SettingsRoute />);
		expect(await screen.findByText("X Remark Live Sync")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Import backup" })).toBeVisible();
		fireEvent.click(screen.getByRole("button", { name: "Pair bridge" }));

		expect(await screen.findByText("a".repeat(43))).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Disconnect" })).toBeVisible();
		await queryClient.refetchQueries({ queryKey: queryKeys.xRemarkLive });
		expect(
			await screen.findByText(
				"Connected · saved and deleted notes appear automatically",
			),
		).toBeVisible();
	});
});
