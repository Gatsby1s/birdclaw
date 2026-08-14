import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	CheckCircle2,
	Bot,
	Cloud,
	Copy,
	Database,
	Download,
	KeyRound,
	Radio,
	RefreshCw,
	Route as RouteIcon,
	Settings2,
	StickyNote,
	Unplug,
	Upload,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
	birdclawSettingsSchema,
	type BirdclawSettings,
	type ProfileAnalysisSourceSetting,
	twitter6551RuntimeStatusSchema,
	twillotManagementResponseSchema,
	xRemarkLiveSyncStatusSchema,
	xRemarkPairingResultSchema,
	xRemarkSyncStatusSchema,
} from "#/lib/api-contracts";
import { fetchJson } from "#/lib/api-client";
import { queryKeys } from "#/lib/query-client";
import type { XRemarkLiveSyncStatus, XRemarkPairingResult } from "#/lib/types";
import {
	cx,
	errorCopyClass,
	pageHeaderClass,
	pageHeaderRowClass,
	pageSubtitleClass,
	pageTitleClass,
	segmentedClass,
	statusCopyClass,
} from "#/lib/ui";

export const Route = createFileRoute("/settings")({
	component: SettingsRoute,
});

const sourceOptions = [
	{
		value: "local",
		label: "Local",
		detail: "Use the BirdClaw archive already on this Mac.",
		icon: Database,
	},
	{
		value: "xurl",
		label: "XURL refresh",
		detail: "Refresh from X URL before analysis.",
		icon: RouteIcon,
	},
	{
		value: "6551",
		label: "6551 refresh",
		detail: "Reserved for the 6551 Twitter API adapter.",
		icon: Cloud,
	},
] as const satisfies Array<{
	value: ProfileAnalysisSourceSetting;
	label: string;
	detail: string;
	icon: typeof Database;
}>;

const twillotCaptureLabels = {
	capture_requested: "Queued",
	waiting_for_twillot: "Waiting for Twillot",
	capturing: "Capturing",
	ingesting: "Importing",
	caught_up_unverified: "Caught up · verify",
	verified_complete: "Verified complete",
	needs_attention: "Needs attention",
} as const;

async function fetchSettings() {
	return fetchJson(
		"/api/settings",
		undefined,
		birdclawSettingsSchema,
		"Settings unavailable",
	);
}

async function updateProfileSource(
	source: ProfileAnalysisSourceSetting,
): Promise<BirdclawSettings> {
	return fetchJson(
		"/api/settings",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ analysis: { profileSource: source } }),
		},
		birdclawSettingsSchema,
		"Settings update failed",
	);
}

type SummaryProvider = "openai" | "deepseek";

async function updateSummaryModels(input: {
	primary: SummaryProvider;
	backup: SummaryProvider;
	apiKey?: string;
}): Promise<BirdclawSettings> {
	return fetchJson(
		"/api/settings",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				analysis: {
					summaryModels: {
						primary: input.primary,
						backup: input.backup,
					},
				},
				...(input.apiKey
					? { providers: { deepseek: { apiKey: input.apiKey } } }
					: {}),
			}),
		},
		birdclawSettingsSchema,
		"Summary model settings update failed",
	);
}

async function syncTwitter6551() {
	return fetchJson(
		"/api/integrations/twitter6551",
		{ method: "POST" },
		twitter6551RuntimeStatusSchema,
		"Twitter recovery sync failed",
	);
}

async function fetchXRemarkStatus() {
	return fetchJson(
		"/api/xremark",
		undefined,
		xRemarkSyncStatusSchema,
		"X Remark status unavailable",
	);
}

async function fetchXRemarkLiveStatus() {
	return fetchJson(
		"/api/integrations/xremark",
		{ cache: "no-store" },
		xRemarkLiveSyncStatusSchema,
		"X Remark live sync status unavailable",
	);
}

async function manageXRemarkLiveSync(
	action: "pair" | "disconnect",
): Promise<XRemarkLiveSyncStatus | XRemarkPairingResult> {
	const init = {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ action }),
	};
	return action === "pair"
		? fetchJson(
				"/api/integrations/xremark",
				init,
				xRemarkPairingResultSchema,
				"X Remark live sync update failed",
			)
		: fetchJson(
				"/api/integrations/xremark",
				init,
				xRemarkLiveSyncStatusSchema,
				"X Remark live sync update failed",
			);
}

async function manageTwillotHistory(input: {
	action: "pair" | "disconnect" | "verify" | "retry";
	jobId?: string;
}) {
	return fetchJson(
		"/api/twillot-history",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(input),
		},
		twillotManagementResponseSchema,
		"Twillot history update failed",
	);
}

async function fetchTwillotHistory() {
	return fetchJson(
		"/api/twillot-history",
		{ cache: "no-store" },
		twillotManagementResponseSchema,
		"Twillot history status unavailable",
	);
}

async function importXRemarkBackup(file: File) {
	if (file.size > 25 * 1024 * 1024) {
		throw new Error(
			"Backup is too large. Export Remarks, Tags, and Categories only.",
		);
	}

	let backup: unknown;
	try {
		backup = JSON.parse(await file.text()) as unknown;
	} catch {
		throw new Error("This is not a valid JSON backup.");
	}

	return fetchJson(
		"/api/xremark",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(backup),
		},
		xRemarkSyncStatusSchema,
		"X Remark import failed",
	);
}

function SettingsRoute() {
	const queryClient = useQueryClient();
	const xRemarkFileRef = useRef<HTMLInputElement>(null);
	const settingsQuery = useQuery({
		queryKey: queryKeys.settings,
		queryFn: fetchSettings,
		refetchInterval: 5_000,
		staleTime: 0,
	});
	const xRemarkQuery = useQuery({
		queryKey: queryKeys.xRemark,
		queryFn: fetchXRemarkStatus,
	});
	const xRemarkLiveQuery = useQuery({
		queryKey: queryKeys.xRemarkLive,
		queryFn: fetchXRemarkLiveStatus,
		refetchInterval: 5_000,
		staleTime: 0,
	});
	const twillotQuery = useQuery({
		queryKey: queryKeys.twillotHistory,
		queryFn: fetchTwillotHistory,
		refetchInterval: 5_000,
		staleTime: 0,
	});
	const settings = settingsQuery.data ?? null;
	const [primaryModel, setPrimaryModel] = useState<SummaryProvider>("openai");
	const [backupModel, setBackupModel] = useState<SummaryProvider>("deepseek");
	const [deepSeekApiKey, setDeepSeekApiKey] = useState("");
	const [twillotPairing, setTwillotPairing] = useState<{
		token: string;
		endpoint: string;
	} | null>(null);
	const mutation = useMutation({
		mutationFn: updateProfileSource,
		onSuccess: (data) => {
			queryClient.setQueryData(queryKeys.settings, data);
			void queryClient.invalidateQueries({ queryKey: queryKeys.dataSources });
		},
	});
	const summaryMutation = useMutation({
		mutationFn: updateSummaryModels,
		onSuccess: (data) => {
			queryClient.setQueryData(queryKeys.settings, data);
			setDeepSeekApiKey("");
		},
	});
	useEffect(() => {
		if (!settings) return;
		setPrimaryModel(settings.analysis.summaryModels.primary);
		setBackupModel(settings.analysis.summaryModels.backup);
	}, [settings]);
	const xRemarkMutation = useMutation({
		mutationFn: importXRemarkBackup,
		onSuccess: (data) => {
			queryClient.setQueryData(queryKeys.xRemark, data);
			void queryClient.invalidateQueries({ queryKey: queryKeys.xRemark });
			void queryClient.invalidateQueries({ queryKey: queryKeys.timelines });
			void queryClient.invalidateQueries({ queryKey: queryKeys.conversations });
		},
	});
	const xRemarkLiveMutation = useMutation({
		mutationFn: manageXRemarkLiveSync,
		onSuccess: (data) => {
			queryClient.setQueryData(queryKeys.xRemarkLive, data);
		},
	});
	const twillotMutation = useMutation({
		mutationFn: manageTwillotHistory,
		onSuccess: (data, input) => {
			const { token: _token, ...statusOnly } = data;
			queryClient.setQueryData(queryKeys.twillotHistory, statusOnly);
			if (data.token) {
				setTwillotPairing({ token: data.token, endpoint: data.endpoint });
			} else if (input.action === "disconnect") {
				setTwillotPairing(null);
			}
			void queryClient.invalidateQueries({
				queryKey: queryKeys.twillotHistory,
			});
			void queryClient.invalidateQueries({ queryKey: queryKeys.timelines });
		},
	});
	const twitter6551Mutation = useMutation({
		mutationFn: syncTwitter6551,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
			void queryClient.invalidateQueries({ queryKey: queryKeys.dataSources });
			void queryClient.invalidateQueries({ queryKey: queryKeys.timelines });
		},
	});
	const currentSource = settings?.analysis.profileSource;
	const pendingSource = mutation.variables;
	const saving = mutation.isPending;
	const twitter6551 = settings?.providers.twitter6551;
	const twillot = twillotQuery.data?.status;
	const twillotManagementAvailable =
		twillotQuery.data?.managementAvailable ?? false;
	const twillotPairingToken = twillotPairing?.token;
	const twillotEndpoint =
		twillotPairing?.endpoint ?? twillotQuery.data?.endpoint;
	const twitter6551Runtime = twitter6551Mutation.data ?? twitter6551?.runtime;
	const xRemarkStatus = xRemarkMutation.data ?? xRemarkQuery.data;
	const xRemarkLiveStatus = xRemarkLiveQuery.data ?? xRemarkLiveMutation.data;
	const pairingToken =
		xRemarkLiveMutation.data && "token" in xRemarkLiveMutation.data
			? xRemarkLiveMutation.data.token
			: undefined;
	const summaryProviders = settings?.providers;
	const summaryChanged = Boolean(
		settings &&
		(primaryModel !== settings.analysis.summaryModels.primary ||
			backupModel !== settings.analysis.summaryModels.backup ||
			deepSeekApiKey.trim()),
	);

	return (
		<section className="flex min-h-screen flex-col">
			<header className={pageHeaderClass}>
				<div className={pageHeaderRowClass}>
					<div>
						<h1 className={pageTitleClass}>Settings</h1>
						<p className={pageSubtitleClass}>
							App-wide source preferences and provider state
						</p>
					</div>
				</div>
			</header>
			{settingsQuery.error ? (
				<div className={errorCopyClass}>
					{settingsQuery.error instanceof Error
						? settingsQuery.error.message
						: "Settings unavailable"}
				</div>
			) : null}
			{mutation.error ? (
				<div className={errorCopyClass}>
					{mutation.error instanceof Error
						? mutation.error.message
						: "Settings update failed"}
				</div>
			) : null}
			{summaryMutation.error ? (
				<div className={errorCopyClass}>
					{summaryMutation.error instanceof Error
						? summaryMutation.error.message
						: "Summary model settings update failed"}
				</div>
			) : null}
			{xRemarkMutation.error ? (
				<div className={errorCopyClass}>
					{xRemarkMutation.error instanceof Error
						? xRemarkMutation.error.message
						: "X Remark import failed"}
				</div>
			) : null}
			{xRemarkLiveMutation.error ? (
				<div className={errorCopyClass}>
					{xRemarkLiveMutation.error instanceof Error
						? xRemarkLiveMutation.error.message
						: "X Remark live sync update failed"}
				</div>
			) : null}
			{twitter6551Mutation.error ? (
				<div className={errorCopyClass}>
					{twitter6551Mutation.error instanceof Error
						? twitter6551Mutation.error.message
						: "Twitter recovery sync failed"}
				</div>
			) : null}
			{twillotMutation.error ? (
				<div className={errorCopyClass}>
					{twillotMutation.error instanceof Error
						? twillotMutation.error.message
						: "Twillot history update failed"}
				</div>
			) : null}
			{twillotQuery.error ? (
				<div className={errorCopyClass}>
					{twillotQuery.error instanceof Error
						? twillotQuery.error.message
						: "Twillot history status unavailable"}
				</div>
			) : null}
			{settings ? (
				<div className="border-t border-[var(--line)]">
					<section className="border-b border-[var(--line)] px-4 py-5">
						<div className="flex items-center gap-2 text-[16px] font-bold text-[var(--ink)]">
							<Bot className="size-4.5" strokeWidth={1.9} />
							<span>AI Summary Models</span>
						</div>
						<p className="mt-1 text-[13px] text-[var(--ink-soft)]">
							Today uses the primary model first and switches to the backup only
							when a clean failover is possible.
						</p>
						<div className="mt-4 grid gap-3 min-[760px]:grid-cols-2">
							<label className="grid gap-1.5 text-[12px] font-semibold text-[var(--ink-soft)]">
								<span>Primary summary model</span>
								<select
									className="min-h-11 rounded-xl border border-[var(--line-strong)] bg-[var(--bg)] px-3 text-[14px] font-semibold text-[var(--ink)] outline-none focus:border-[var(--accent)]"
									value={primaryModel}
									onChange={(event) => {
										const next = event.currentTarget.value as SummaryProvider;
										setPrimaryModel(next);
										setBackupModel(next === "openai" ? "deepseek" : "openai");
									}}
								>
									<option value="openai">
										ChatGPT · {summaryProviders?.openai.model}
									</option>
									<option value="deepseek">DeepSeek V4 / Flash</option>
								</select>
							</label>
							<label className="grid gap-1.5 text-[12px] font-semibold text-[var(--ink-soft)]">
								<span>Backup summary model</span>
								<select
									className="min-h-11 rounded-xl border border-[var(--line-strong)] bg-[var(--bg)] px-3 text-[14px] font-semibold text-[var(--ink)] outline-none focus:border-[var(--accent)]"
									value={backupModel}
									onChange={(event) => {
										const next = event.currentTarget.value as SummaryProvider;
										setBackupModel(next);
										setPrimaryModel(next === "openai" ? "deepseek" : "openai");
									}}
								>
									<option value="openai">
										ChatGPT · {summaryProviders?.openai.model}
									</option>
									<option value="deepseek">DeepSeek V4 / Flash</option>
								</select>
							</label>
						</div>
						<div className="mt-3 grid gap-3 min-[760px]:grid-cols-[minmax(0,1fr)_auto] min-[760px]:items-end">
							<label className="grid gap-1.5 text-[12px] font-semibold text-[var(--ink-soft)]">
								<span>
									DeepSeek API token ·{" "}
									{summaryProviders?.deepseek.tokenConfigured
										? "Configured"
										: "Not configured"}
								</span>
								<input
									autoComplete="new-password"
									className="min-h-11 rounded-xl border border-[var(--line-strong)] bg-[var(--bg)] px-3 text-[14px] text-[var(--ink)] outline-none placeholder:text-[var(--ink-soft)] focus:border-[var(--accent)]"
									placeholder={
										summaryProviders?.deepseek.tokenConfigured
											? "Leave blank to keep the saved token"
											: "Paste DeepSeek API token"
									}
									type="password"
									value={deepSeekApiKey}
									onChange={(event) =>
										setDeepSeekApiKey(event.currentTarget.value)
									}
								/>
							</label>
							<button
								className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full bg-[var(--accent)] px-4 text-[13px] font-bold text-[var(--accent-text)] disabled:opacity-50"
								disabled={!summaryChanged || summaryMutation.isPending}
								onClick={() =>
									summaryMutation.mutate({
										primary: primaryModel,
										backup: backupModel,
										...(deepSeekApiKey.trim()
											? { apiKey: deepSeekApiKey.trim() }
											: {}),
									})
								}
								type="button"
							>
								{summaryMutation.isPending ? "Saving" : "Save model settings"}
							</button>
						</div>
						<p
							className="mt-2 text-[11px] text-[var(--ink-soft)]"
							aria-live="polite"
						>
							Primary:{" "}
							{primaryModel === "openai" ? "ChatGPT" : "DeepSeek V4 / Flash"} ·
							Backup:{" "}
							{backupModel === "openai" ? "ChatGPT" : "DeepSeek V4 / Flash"}.
							Tokens are stored only in this Mac’s private BirdClaw config.
						</p>
					</section>
					<section className="border-b border-[var(--line)] px-4 py-4">
						<div className="flex flex-col gap-3">
							<div className="flex flex-col gap-3 min-[760px]:flex-row min-[760px]:items-start min-[760px]:justify-between">
								<div className="min-w-0">
									<div className="flex items-center gap-2 text-[16px] font-bold text-[var(--ink)]">
										<Download className="size-4.5" strokeWidth={1.9} />
										<span>Twillot History Queue</span>
									</div>
									<p className="mt-1 text-[13px] text-[var(--ink-soft)]">
										{twillotQuery.data && !twillotManagementAvailable
											? "The capture queue runs beside Chrome. Open local BirdClaw at 127.0.0.1:3001 to manage it."
											: twillot
												? `${twillot.capturedToday.toLocaleString()} / ${twillot.dailyLimit.toLocaleString()} processed today · ${twillot.remainingToday.toLocaleString()} remaining`
												: "Preparing the Twillot history queue."}
									</p>
									{twillot && twillotManagementAvailable ? (
										<p className="mt-1 text-[12px] text-[var(--ink-soft)]">
											{String(twillot.queueCounts.queued)} queued ·{" "}
											{String(twillot.queueCounts.active)} active ·{" "}
											{String(twillot.queueCounts.deferred)} next-day ·{" "}
											{twillot.followDetection.enabled
												? `following checked every ${String(twillot.followDetection.intervalMinutes)} min`
												: "automatic follow detection starts after pairing"}
										</p>
									) : null}
								</div>
								{twillotManagementAvailable ? (
									<div className="flex shrink-0 flex-wrap items-center gap-2">
										{twillot?.companion.paired ? (
											<button
												className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-[var(--line-strong)] px-3 py-1 text-[13px] font-bold text-[var(--ink)] hover:bg-[var(--bg-hover)] disabled:opacity-55"
												disabled={twillotMutation.isPending}
												onClick={() =>
													twillotMutation.mutate({ action: "disconnect" })
												}
												type="button"
											>
												<Unplug className="size-4" strokeWidth={2} />
												Disconnect
											</button>
										) : null}
										<button
											className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-[var(--line-strong)] px-3 py-1 text-[13px] font-bold text-[var(--ink)] hover:bg-[var(--bg-hover)] disabled:opacity-55"
											disabled={twillotMutation.isPending}
											onClick={() => twillotMutation.mutate({ action: "pair" })}
											type="button"
										>
											<KeyRound className="size-4" strokeWidth={2} />
											{twillotMutation.isPending
												? "Preparing"
												: twillot?.companion.paired
													? "Reset token"
													: "Pair companion"}
										</button>
									</div>
								) : null}
							</div>

							{twillotPairingToken && twillotEndpoint ? (
								<div className="grid gap-2 rounded-xl border border-[var(--line)] bg-[var(--bg-subtle)] p-3">
									<p className="text-[12px] font-semibold text-[var(--ink)]">
										Save these once in the BirdClaw Twillot bridge.
									</p>
									{[
										["Endpoint", twillotEndpoint],
										["Pairing token", twillotPairingToken],
									].map(([label, value]) => (
										<div
											className="flex min-w-0 items-center gap-2"
											key={label}
										>
											<span className="w-24 shrink-0 text-[11px] font-semibold text-[var(--ink-soft)]">
												{label}
											</span>
											<code className="min-w-0 flex-1 truncate text-[12px] text-[var(--ink)]">
												{value}
											</code>
											<button
												aria-label={`Copy ${label}`}
												className="inline-flex size-11 shrink-0 items-center justify-center rounded-full border border-[var(--line-strong)] text-[var(--ink)] hover:bg-[var(--bg-hover)]"
												onClick={() =>
													void navigator.clipboard.writeText(value)
												}
												type="button"
											>
												<Copy className="size-4" strokeWidth={2} />
											</button>
										</div>
									))}
									<button
										className="min-h-11 justify-self-start rounded-full border border-[var(--line-strong)] px-3 text-[12px] font-bold text-[var(--ink)] hover:bg-[var(--bg-hover)]"
										onClick={() => setTwillotPairing(null)}
										type="button"
									>
										Hide pairing secret
									</button>
								</div>
							) : null}

							{twillotManagementAvailable && twillot?.jobs.length ? (
								<div className="grid gap-2">
									{twillot.jobs.slice(0, 8).map((job) => (
										<div
											className="flex min-w-0 flex-col gap-2 rounded-xl border border-[var(--line)] px-3 py-2 min-[600px]:flex-row min-[600px]:items-center min-[600px]:justify-between"
											key={job.id}
										>
											<div className="min-w-0">
												<p className="truncate text-[13px] font-bold text-[var(--ink)]">
													@{job.handle}
												</p>
												<p className="text-[11px] text-[var(--ink-soft)]">
													{twillotCaptureLabels[job.captureStatus]} ·{" "}
													{job.importedCount.toLocaleString()} imported
												</p>
											</div>
											{job.captureStatus === "caught_up_unverified" ? (
												<button
													className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-full border border-[var(--line-strong)] px-3 text-[12px] font-bold text-[var(--ink)] hover:bg-[var(--bg-hover)]"
													disabled={twillotMutation.isPending}
													onClick={() =>
														twillotMutation.mutate({
															action: "verify",
															jobId: job.id,
														})
													}
													type="button"
												>
													Mark verified
												</button>
											) : job.captureStatus === "needs_attention" ? (
												<button
													className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-full border border-[var(--line-strong)] px-3 text-[12px] font-bold text-[var(--ink)] hover:bg-[var(--bg-hover)]"
													disabled={twillotMutation.isPending}
													onClick={() =>
														twillotMutation.mutate({
															action: "retry",
															jobId: job.id,
														})
													}
													type="button"
												>
													Retry
												</button>
											) : null}
										</div>
									))}
								</div>
							) : null}

							<p className="text-[11px] leading-5 text-[var(--ink-soft)]">
								Mini is treated as a 20,000-record daily soft budget. The queue
								executes locally beside Chrome; imported canonical tweets are
								forwarded to Railway by BirdClaw’s existing cloud bridge.
								Twillot has no supported task API or remaining-quota endpoint,
								so the bridge opens the official page and waits for you to start
								the export. A finished capture remains unverified until its
								history boundary is checked.
							</p>
						</div>
					</section>
					<section className="border-b border-[var(--line)] px-4 py-4">
						<div className="flex flex-col gap-3 min-[760px]:flex-row min-[760px]:items-center min-[760px]:justify-between">
							<div className="min-w-0">
								<div className="flex items-center gap-2 text-[16px] font-bold text-[var(--ink)]">
									<StickyNote className="size-4.5" strokeWidth={1.9} />
									<span>X Remark Notes</span>
								</div>
								<p className="mt-1 text-[13px] text-[var(--ink-soft)]">
									{xRemarkStatus?.imported
										? `${String(xRemarkStatus.annotationCount)} notes imported · ${String(xRemarkStatus.matchedProfileCount)} matched to BirdClaw profiles`
										: "Export Remarks, Tags, and Categories from X Remark, then import that JSON backup here."}
								</p>
								{xRemarkStatus?.importedAt ? (
									<p className="mt-1 text-[12px] text-[var(--ink-soft)]">
										Last import:{" "}
										{new Date(xRemarkStatus.importedAt).toLocaleString()}
									</p>
								) : null}
							</div>
							<div className="shrink-0">
								<input
									ref={xRemarkFileRef}
									accept="application/json,.json"
									className="sr-only"
									onChange={(event) => {
										const file = event.target.files?.[0];
										if (file) xRemarkMutation.mutate(file);
										event.target.value = "";
									}}
									type="file"
								/>
								<button
									className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-[var(--line-strong)] px-3 py-1 text-[13px] font-bold text-[var(--ink)] transition-colors duration-150 hover:bg-[var(--bg-hover)] disabled:opacity-55"
									disabled={xRemarkMutation.isPending}
									onClick={() => xRemarkFileRef.current?.click()}
									type="button"
								>
									<Upload className="size-4" strokeWidth={2} />
									{xRemarkMutation.isPending
										? "Importing"
										: xRemarkStatus?.imported
											? "Replace from backup"
											: "Import backup"}
								</button>
							</div>
						</div>
					</section>
					<section className="border-b border-[var(--line)] px-4 py-4">
						<div className="flex flex-col gap-3 min-[760px]:flex-row min-[760px]:items-center min-[760px]:justify-between">
							<div className="min-w-0">
								<div className="flex items-center gap-2 text-[16px] font-bold text-[var(--ink)]">
									<Radio className="size-4.5" strokeWidth={1.9} />
									<span>X Remark Live Sync</span>
								</div>
								<p className="mt-1 text-[13px] text-[var(--ink-soft)]">
									{xRemarkLiveStatus?.connected
										? "Connected · saved and deleted notes appear automatically"
										: xRemarkLiveStatus?.paired
											? "Paired · waiting for the local X Remark bridge"
											: "Pair the local bridge to enable automatic updates."}
								</p>
								{xRemarkLiveStatus?.lastSeenAt ? (
									<p className="mt-1 text-[12px] text-[var(--ink-soft)]">
										Last heartbeat:{" "}
										{new Date(xRemarkLiveStatus.lastSeenAt).toLocaleString()}
									</p>
								) : null}
								{pairingToken ? (
									<div className="mt-2 flex max-w-xl items-center gap-2">
										<code className="min-w-0 flex-1 truncate rounded-md border border-[var(--line)] bg-[var(--bg-subtle)] px-2 py-1 text-[12px] text-[var(--ink)]">
											{pairingToken}
										</code>
										<button
											aria-label="Copy pairing token"
											className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-[var(--line-strong)] text-[var(--ink)] hover:bg-[var(--bg-hover)]"
											onClick={() =>
												void navigator.clipboard.writeText(pairingToken)
											}
											type="button"
										>
											<Copy className="size-4" strokeWidth={2} />
										</button>
									</div>
								) : null}
							</div>
							<div className="flex shrink-0 items-center gap-2">
								{xRemarkLiveStatus?.paired ? (
									<button
										className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-[var(--line-strong)] px-3 py-1 text-[13px] font-bold text-[var(--ink)] hover:bg-[var(--bg-hover)] disabled:opacity-55"
										disabled={xRemarkLiveMutation.isPending}
										onClick={() => xRemarkLiveMutation.mutate("disconnect")}
										type="button"
									>
										<Unplug className="size-4" strokeWidth={2} />
										Disconnect
									</button>
								) : null}
								<button
									className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-[var(--line-strong)] px-3 py-1 text-[13px] font-bold text-[var(--ink)] hover:bg-[var(--bg-hover)] disabled:opacity-55"
									disabled={xRemarkLiveMutation.isPending}
									onClick={() => xRemarkLiveMutation.mutate("pair")}
									type="button"
								>
									<KeyRound className="size-4" strokeWidth={2} />
									{xRemarkLiveMutation.isPending
										? "Preparing"
										: xRemarkLiveStatus?.paired
											? "Reset token"
											: "Pair bridge"}
								</button>
							</div>
						</div>
					</section>
					<section className="border-b border-[var(--line)] px-4 py-4">
						<div className="flex flex-col gap-3 min-[760px]:flex-row min-[760px]:items-center min-[760px]:justify-between">
							<div className="min-w-0">
								<div className="flex items-center gap-2 text-[16px] font-bold text-[var(--ink)]">
									<Settings2 className="size-4.5" strokeWidth={1.9} />
									<span>Profile Analyse Source</span>
								</div>
								<p className="mt-1 text-[13px] text-[var(--ink-soft)]">
									{sourceOptions.find(
										(option) => option.value === currentSource,
									)?.detail ?? "No source selected."}
								</p>
							</div>
							<div className={cx(segmentedClass, "max-w-full flex-wrap")}>
								{sourceOptions.map((option) => {
									const Icon = option.icon;
									const active = option.value === currentSource;
									const pending = saving && pendingSource === option.value;
									return (
										<button
											key={option.value}
											type="button"
											className={cx(
												"inline-flex min-h-8 items-center gap-1.5 rounded-full px-3 py-1 text-[13px] font-bold transition-colors duration-150 disabled:cursor-default disabled:opacity-55",
												active
													? "bg-[var(--bg-active)] text-[var(--ink)]"
													: "text-[var(--ink-soft)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink)]",
											)}
											disabled={saving || active}
											onClick={() => mutation.mutate(option.value)}
										>
											<Icon className="size-4" strokeWidth={2} />
											<span>{pending ? "Saving" : option.label}</span>
										</button>
									);
								})}
							</div>
						</div>
					</section>
					<section className="border-b border-[var(--line)] px-4 py-4">
						<div className="flex flex-col gap-3 min-[760px]:flex-row min-[760px]:items-center min-[760px]:justify-between">
							<div className="min-w-0">
								<div className="flex items-center gap-2 text-[16px] font-bold text-[var(--ink)]">
									<KeyRound className="size-4.5" strokeWidth={1.9} />
									<span>Twitter recovery</span>
								</div>
								<p className="mt-1 break-all text-[13px] text-[var(--ink-soft)]">
									{twitter6551?.fxtwitterEnabled
										? "api.fxtwitter.com · free public recovery"
										: `${twitter6551?.baseUrl} · ${twitter6551?.tokenEnv}`}
								</p>
								{twitter6551?.fxtwitterEnabled ? (
									<p className="mt-1 text-[12px] text-[var(--ink-soft)]">
										Public watched-account and thread recovery; not a complete
										Following Home replacement.
									</p>
								) : null}
								<p className="mt-1 text-[13px] text-[var(--ink-soft)]">
									{twitter6551Runtime?.activeSource ?? "disabled"} ·{" "}
									{String(twitter6551?.watchUsers.length ?? 0)} watched accounts
									· {String(twitter6551?.targetTweetIds.length ?? 0)} pinned
									posts
								</p>
								{twitter6551Runtime?.lastLocalHeartbeatAt ? (
									<p className="mt-1 text-[12px] text-[var(--ink-soft)]">
										Last local heartbeat:{" "}
										{new Date(
											twitter6551Runtime.lastLocalHeartbeatAt,
										).toLocaleString()}
									</p>
								) : null}
								{twitter6551Runtime?.lastBackfillAt ? (
									<p className="mt-1 text-[12px] text-[var(--ink-soft)]">
										Last recovery sync:{" "}
										{new Date(
											twitter6551Runtime.lastBackfillAt,
										).toLocaleString()}
									</p>
								) : null}
								{twitter6551Runtime?.lastError ? (
									<p className="mt-1 text-[12px] text-[var(--alert)]">
										{twitter6551Runtime.lastError}
									</p>
								) : null}
							</div>
							<div className="flex shrink-0 flex-wrap items-center gap-2">
								<span
									className={cx(
										"inline-flex min-h-8 w-fit items-center gap-1.5 rounded-full border px-3 py-1 text-[13px] font-bold",
										twitter6551Runtime?.connected ||
											twitter6551Runtime?.activeSource === "local"
											? "border-[color:color-mix(in_srgb,#22c55e_45%,var(--line))] text-[var(--ink)]"
											: "border-[var(--line)] text-[var(--ink-soft)]",
									)}
								>
									<CheckCircle2 className="size-4" strokeWidth={2} />
									{twitter6551Runtime?.activeSource === "local"
										? twitter6551?.fxtwitterEnabled
											? "Local · FX standby"
											: "Local · 6551 standby"
										: twitter6551Runtime?.connected
											? "Live"
											: !twitter6551?.fxtwitterEnabled &&
												  !twitter6551?.tokenDetected
												? "No token"
												: !twitter6551Runtime?.enabled
													? "Disabled"
													: twitter6551Runtime.state === "error"
														? "Error"
														: "Recovery polling"}
								</span>
								<button
									className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-[var(--line-strong)] px-3 py-1 text-[13px] font-bold text-[var(--ink)] hover:bg-[var(--bg-hover)] disabled:opacity-55"
									disabled={
										!twitter6551Runtime?.enabled ||
										(twitter6551Runtime?.activeSource === "local" &&
											!twitter6551?.fxtwitterEnabled) ||
										twitter6551Mutation.isPending
									}
									onClick={() => twitter6551Mutation.mutate()}
									type="button"
								>
									<RefreshCw
										className={cx(
											"size-4",
											twitter6551Mutation.isPending && "animate-spin",
										)}
										strokeWidth={2}
									/>
									{twitter6551?.fxtwitterEnabled ? "Sync free" : "Sync now"}
								</button>
							</div>
						</div>
					</section>
				</div>
			) : settingsQuery.isFetching ? (
				<div className={statusCopyClass}>Loading settings...</div>
			) : null}
		</section>
	);
}
