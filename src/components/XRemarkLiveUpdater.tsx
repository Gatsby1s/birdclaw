import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { xRemarkLiveSyncStatusSchema } from "#/lib/api-contracts";
import { fetchJson } from "#/lib/api-client";
import { queryKeys } from "#/lib/query-client";
import type { XRemarkLiveSyncStatus } from "#/lib/types";

const DEFAULT_POLL_MS = 2_000;

export function isLoopbackHostname(hostname: string) {
	const normalized = hostname
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, "");
	const ipv4Parts = normalized.split(".");
	const isLoopbackIpv4 =
		ipv4Parts.length === 4 &&
		ipv4Parts[0] === "127" &&
		ipv4Parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
	return (
		normalized === "localhost" ||
		normalized.endsWith(".localhost") ||
		normalized === "::1" ||
		isLoopbackIpv4
	);
}

function runsOnLoopback() {
	return (
		typeof window !== "undefined" &&
		isLoopbackHostname(window.location.hostname)
	);
}

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
	enabled = runsOnLoopback(),
}: {
	pollMs?: number;
	fetchStatus?: () => Promise<XRemarkLiveSyncStatus>;
	enabled?: boolean;
}) {
	const queryClient = useQueryClient();
	const previousSnapshotAt = useRef<string | null | undefined>(undefined);
	const statusQuery = useQuery({
		queryKey: queryKeys.xRemarkLive,
		queryFn: fetchStatus,
		enabled,
		refetchInterval: enabled ? pollMs : false,
		staleTime: 0,
	});

	useEffect(() => {
		if (!enabled || !statusQuery.data) return;
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
	}, [enabled, queryClient, statusQuery.data?.lastSnapshotAt]);

	return null;
}
