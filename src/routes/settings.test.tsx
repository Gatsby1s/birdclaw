import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "#/lib/query-client";
import { renderWithQueryClient as render } from "#/test/render";
import { Route } from "./settings";

const SettingsRoute = Route.options.component as ComponentType;

function settingsPayload(profileSource: "local" | "xurl" | "6551") {
	return {
		analysis: {
			profileSource,
			summaryModels: { primary: "openai", backup: "deepseek" },
		},
		providers: {
			openai: {
				label: "ChatGPT",
				model: "gpt-5.5",
				tokenConfigured: true,
			},
			deepseek: {
				label: "DeepSeek V4 / Flash",
				baseUrl: "https://api.deepseek.com",
				model: "deepseek-v4-flash",
				tokenConfigured: false,
			},
			twitter6551: {
				baseUrl: "https://ai.6551.io",
				tokenEnv: "TWITTER_TOKEN",
				tokenDetected: false,
			},
		},
	};
}

function twillotPayload(): any {
	return {
		ok: true,
		endpoint: "http://127.0.0.1:3001/api/integrations/twillot-history",
		localQueueExecutor: true,
		managementAvailable: true,
		status: {
			plan: "Mini",
			monthlyPriceUsd: 4.99,
			dailyLimit: 20_000,
			softBudget: true,
			usageDay: "2026-08-10",
			capturedToday: 0,
			reservedToday: 0,
			remainingToday: 20_000,
			nextResetAt: "2026-08-10T16:00:00.000Z",
			nextEligibleAt: null,
			totalImported: 0,
			queueCounts: {
				queued: 0,
				active: 0,
				deferred: 0,
				caughtUpUnverified: 0,
				verifiedComplete: 0,
				needsAttention: 0,
			},
			companion: {
				paired: false,
				connected: false,
				tokenCreatedAt: null,
				lastSeenAt: null,
				lastError: null,
			},
			followDetection: {
				enabled: false,
				running: false,
				intervalMinutes: 360,
				lastStartedAt: null,
				lastSuccessAt: null,
				lastError: null,
			},
			jobs: [],
			limitations: {
				vendorStartRequiresUser: true,
				providerRemainingUnknown: true,
				caughtUpRequiresVerification: true,
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
				if (url.pathname === "/api/twillot-history") {
					return Response.json(twillotPayload());
				}
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
				if (url.pathname === "/api/twillot-history") {
					return Response.json(twillotPayload());
				}
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
				if (url.pathname === "/api/twillot-history") {
					return Response.json(twillotPayload());
				}
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

	it("refreshes Twillot status after pairing instead of pinning mutation data", async () => {
		let paired = false;
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
					return Response.json({
						paired: false,
						connected: false,
						extensionId: "imbbpjelfehedmikmbjglhpoiehpjjhl",
						endpoint: "http://127.0.0.1:3001/api/integrations/xremark/snapshot",
						lastSequence: 0,
					});
				}
				if (url.pathname === "/api/twillot-history") {
					if (init?.method === "POST") {
						paired = true;
						const response = twillotPayload();
						response.status.capturedToday = 1;
						response.status.remainingToday = 19_999;
						return Response.json({ ...response, token: "t".repeat(43) });
					}
					const response = twillotPayload();
					if (paired) {
						response.status.capturedToday = 2;
						response.status.remainingToday = 19_998;
						response.status.companion.paired = true;
					}
					return Response.json(response);
				}
				throw new Error(`Unexpected URL: ${url.pathname}`);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		const { queryClient } = render(<SettingsRoute />);
		expect(
			await screen.findByText("Twillot History Queue"),
		).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Pair companion" }));
		expect(await screen.findByText("t".repeat(43))).toBeInTheDocument();
		await queryClient.refetchQueries({ queryKey: queryKeys.twillotHistory });
		expect(
			await screen.findByText("2 / 20,000 processed today · 19,998 remaining"),
		).toBeVisible();
		fireEvent.click(
			screen.getByRole("button", { name: "Hide pairing secret" }),
		);
		expect(screen.queryByText("t".repeat(43))).not.toBeInTheDocument();
	});

	it("renders active Twillot queue states and sends verify and retry actions", async () => {
		const twillot = twillotPayload();
		twillot.status.capturedToday = 345;
		twillot.status.reservedToday = 200;
		twillot.status.remainingToday = 19_455;
		twillot.status.companion = {
			paired: true,
			connected: true,
			tokenCreatedAt: "2026-08-10T00:00:00.000Z",
			lastSeenAt: "2026-08-10T01:00:00.000Z",
			lastError: null,
		};
		twillot.status.followDetection = {
			enabled: true,
			running: false,
			intervalMinutes: 360,
			lastStartedAt: "2026-08-10T00:00:00.000Z",
			lastSuccessAt: "2026-08-10T00:01:00.000Z",
			lastError: null,
		};
		twillot.status.queueCounts = {
			queued: 1,
			active: 1,
			deferred: 1,
			caughtUpUnverified: 1,
			verifiedComplete: 0,
			needsAttention: 1,
		};
		twillot.status.jobs = [
			{
				id: "00000000-0000-4000-8000-000000000001",
				handle: "caught_up",
				state: "completed",
				captureStatus: "caught_up_unverified",
				nextRunAt: "2026-08-10T01:00:00.000Z",
				importedCount: 120,
				downloadedCount: 120,
				attemptCount: 1,
				lastError: null,
				updatedAt: "2026-08-10T01:00:00.000Z",
			},
			{
				id: "00000000-0000-4000-8000-000000000002",
				handle: "failed_target",
				state: "failed",
				captureStatus: "needs_attention",
				nextRunAt: "2026-08-10T01:00:00.000Z",
				importedCount: 4,
				downloadedCount: 4,
				attemptCount: 2,
				lastError: "schema changed",
				updatedAt: "2026-08-10T01:00:00.000Z",
			},
		];
		const actions: unknown[] = [];
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/settings")
					return Response.json(settingsPayload("local"));
				if (url.pathname === "/api/xremark")
					return Response.json({
						imported: false,
						annotationCount: 0,
						matchedProfileCount: 0,
					});
				if (url.pathname === "/api/integrations/xremark")
					return Response.json({
						paired: false,
						connected: false,
						extensionId: "imbbpjelfehedmikmbjglhpoiehpjjhl",
						endpoint: "http://127.0.0.1:3001/api/integrations/xremark/snapshot",
						lastSequence: 0,
					});
				if (url.pathname === "/api/twillot-history") {
					if (init?.method === "POST")
						actions.push(JSON.parse(String(init.body)));
					return Response.json(twillot);
				}
				throw new Error(`Unexpected URL: ${url.pathname}`);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		render(<SettingsRoute />);
		expect(await screen.findByText("@caught_up")).toBeVisible();
		expect(screen.getByText("@failed_target")).toBeVisible();
		expect(screen.getByText(/following checked every 360 min/)).toBeVisible();
		fireEvent.click(screen.getByRole("button", { name: "Mark verified" }));
		await waitFor(() =>
			expect(actions).toContainEqual({
				action: "verify",
				jobId: "00000000-0000-4000-8000-000000000001",
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await waitFor(() =>
			expect(actions).toContainEqual({
				action: "retry",
				jobId: "00000000-0000-4000-8000-000000000002",
			}),
		);
	});

	it("explains that remote Settings cannot manage the local Twillot executor", async () => {
		const remote = twillotPayload();
		remote.managementAvailable = false;
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input), "http://localhost");
			if (url.pathname === "/api/settings")
				return Response.json(settingsPayload("local"));
			if (url.pathname === "/api/twillot-history") return Response.json(remote);
			if (url.pathname === "/api/xremark")
				return Response.json({
					imported: false,
					annotationCount: 0,
					matchedProfileCount: 0,
				});
			return Response.json({
				paired: false,
				connected: false,
				extensionId: "imbbpjelfehedmikmbjglhpoiehpjjhl",
				endpoint: "http://127.0.0.1:3001/api/integrations/xremark/snapshot",
				lastSequence: 0,
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<SettingsRoute />);
		expect(
			await screen.findByText(
				"The capture queue runs beside Chrome. Open local BirdClaw at 127.0.0.1:3001 to manage it.",
			),
		).toBeVisible();
		expect(
			screen.queryByRole("button", { name: "Pair companion" }),
		).not.toBeInTheDocument();
	});
});
