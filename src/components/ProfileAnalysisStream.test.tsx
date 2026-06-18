import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ndjsonResponse } from "#/test/ndjson";
import { createTestQueryClient } from "#/test/render";
import { useProfileAnalysisStream } from "./ProfileAnalysisStream";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("useProfileAnalysisStream", () => {
	it("reports a stream that closes before a terminal event", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ndjsonResponse([{ type: "delta", delta: "partial" }])),
		);
		const queryClient = createTestQueryClient();
		const { result } = renderHook(() => useProfileAnalysisStream("alice"), {
			wrapper: ({ children }) => (
				<QueryClientProvider client={queryClient}>
					{children}
				</QueryClientProvider>
			),
		});

		act(() => result.current.run());

		await waitFor(() =>
			expect(result.current.error).toBe(
				"Profile analysis connection closed before completion. Retry to continue.",
			),
		);
		expect(result.current.loading).toBe(false);
	});
});
