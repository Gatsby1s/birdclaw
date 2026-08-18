// @vitest-environment-options {"url":"https://birdclaw-production.up.railway.app/"}
import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "#/lib/query-client";
import { renderWithQueryClient } from "#/test/render";
import type { XRemarkLiveSyncStatus } from "#/lib/types";
import { isLoopbackHostname, XRemarkLiveUpdater } from "./XRemarkLiveUpdater";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe("XRemarkLiveUpdater", () => {
	it("recognizes browser loopback hostnames", () => {
		expect(isLoopbackHostname("localhost")).toBe(true);
		expect(isLoopbackHostname("birdclaw.localhost")).toBe(true);
		expect(isLoopbackHostname("127.0.0.1")).toBe(true);
		expect(isLoopbackHostname("127.255.255.255")).toBe(true);
		expect(isLoopbackHostname("127.example.com")).toBe(false);
		expect(isLoopbackHostname("[::1]")).toBe(true);
		expect(isLoopbackHostname("birdclaw-production.up.railway.app")).toBe(
			false,
		);
	});

	it("invalidates visible note-bearing queries when a live snapshot arrives", async () => {
		const fetchStatus = vi
			.fn<() => Promise<XRemarkLiveSyncStatus>>()
			.mockResolvedValueOnce({
				paired: true,
				connected: true,
				extensionId: "imbbpjelfehedmikmbjglhpoiehpjjhl",
				endpoint:
					"https://birdclaw-production.up.railway.app/api/integrations/xremark/snapshot",
				lastSequence: 1,
			})
			.mockResolvedValue({
				paired: true,
				connected: true,
				extensionId: "imbbpjelfehedmikmbjglhpoiehpjjhl",
				endpoint:
					"https://birdclaw-production.up.railway.app/api/integrations/xremark/snapshot",
				lastSequence: 1,
				lastSnapshotAt: "2026-07-19T12:00:00.000Z",
			});
		const { queryClient } = renderWithQueryClient(
			<XRemarkLiveUpdater enabled fetchStatus={fetchStatus} pollMs={10} />,
		);
		const invalidate = vi.spyOn(queryClient, "invalidateQueries");

		await waitFor(() => {
			expect(fetchStatus.mock.calls.length).toBeGreaterThanOrEqual(2);
			expect(invalidate).toHaveBeenCalledWith({
				queryKey: queryKeys.timelines,
			});
		});
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: queryKeys.conversations,
		});
	});

	it("polls X Remark from the cloud deployment", async () => {
		vi.useFakeTimers();
		const fetchStatus = vi
			.fn<() => Promise<XRemarkLiveSyncStatus>>()
			.mockResolvedValue({
				paired: true,
				connected: true,
				extensionId: "imbbpjelfehedmikmbjglhpoiehpjjhl",
				endpoint:
					"https://birdclaw-production.up.railway.app/api/integrations/xremark/snapshot",
				lastSequence: 1,
			});

		renderWithQueryClient(
			<XRemarkLiveUpdater fetchStatus={fetchStatus} pollMs={10} />,
		);

		await vi.advanceTimersByTimeAsync(100);
		expect(fetchStatus).toHaveBeenCalled();
	});
});
