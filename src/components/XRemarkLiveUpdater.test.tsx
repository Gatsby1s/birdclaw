import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "#/lib/query-client";
import { renderWithQueryClient } from "#/test/render";
import type { XRemarkLiveSyncStatus } from "#/lib/types";
import { XRemarkLiveUpdater } from "./XRemarkLiveUpdater";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe("XRemarkLiveUpdater", () => {
	it("invalidates visible note-bearing queries when a live snapshot arrives", async () => {
		const fetchStatus = vi
			.fn<() => Promise<XRemarkLiveSyncStatus>>()
			.mockResolvedValueOnce({
				paired: true,
				connected: true,
				extensionId: "imbbpjelfehedmikmbjglhpoiehpjjhl",
				endpoint: "http://127.0.0.1:3001/api/integrations/xremark/snapshot",
				lastSequence: 1,
			})
			.mockResolvedValue({
				paired: true,
				connected: true,
				extensionId: "imbbpjelfehedmikmbjglhpoiehpjjhl",
				endpoint: "http://127.0.0.1:3001/api/integrations/xremark/snapshot",
				lastSequence: 1,
				lastSnapshotAt: "2026-07-19T12:00:00.000Z",
			});
		const { queryClient } = renderWithQueryClient(
			<XRemarkLiveUpdater fetchStatus={fetchStatus} pollMs={10} />,
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
});
