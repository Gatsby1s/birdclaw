import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { xRemarkLiveSyncStatusSchema } from "#/lib/api-contracts";
import { fetchJson } from "#/lib/api-client";
import { queryKeys } from "#/lib/query-client";
import type { XRemarkLiveSyncStatus } from "#/lib/types";

const DEFAULT_POLL_MS = 2_000;

async function fetchXRemarkStatus() {
	return fetchJson(
		"/api/integrations/xremark",
		{ cache: "no-store" },
		xRemarkLiveSyncStatusSchema,
		"X Remark live sync status unavailable",
	);
}

export function XRemarkLiveUpdater({
	pollMs = DEFAULT_POLL_MS,
	fetchStatus = fetchXRemarkStatus,
}: {
	pollMs?: number;
	fetchStatus?: () => Promise<XRemarkLiveSyncStatus>;
}) {
	const queryClient = useQueryClient();
	const previousSnapshotAt = useRef<string | null | undefined>(undefined);
	const statusQuery = useQuery({
		queryKey: queryKeys.xRemarkLive,
		queryFn: fetchStatus,
		refetchInterval: pollMs,
		staleTime: 0,
	});

	useEffect(() => {
		if (!statusQuery.data) return;
		const snapshotAt = statusQuery.data.lastSnapshotAt ?? null;
		const previous = previousSnapshotAt.current;
		previousSnapshotAt.current = snapshotAt;
		if (snapshotAt === null || previous === snapshotAt) return;

		void Promise.all([
			queryClient.invalidateQueries({ queryKey: queryKeys.xRemark }),
			queryClient.invalidateQueries({ queryKey: queryKeys.timelines }),
			queryClient.invalidateQueries({ queryKey: queryKeys.conversations }),
			queryClient.invalidateQueries({ queryKey: queryKeys.profileHydration }),
		]);
	}, [queryClient, statusQuery.data?.lastSnapshotAt]);

	return null;
}
