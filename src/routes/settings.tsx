import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	CheckCircle2,
	Cloud,
	Database,
	KeyRound,
	Route as RouteIcon,
	Settings2,
} from "lucide-react";
import {
	birdclawSettingsSchema,
	type BirdclawSettings,
	type ProfileAnalysisSourceSetting,
} from "#/lib/api-contracts";
import { fetchJson } from "#/lib/api-client";
import { queryKeys } from "#/lib/query-client";
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

function SettingsRoute() {
	const queryClient = useQueryClient();
	const settingsQuery = useQuery({
		queryKey: queryKeys.settings,
		queryFn: fetchSettings,
	});
	const settings = settingsQuery.data ?? null;
	const mutation = useMutation({
		mutationFn: updateProfileSource,
		onSuccess: (data) => {
			queryClient.setQueryData(queryKeys.settings, data);
			void queryClient.invalidateQueries({ queryKey: queryKeys.dataSources });
		},
	});
	const currentSource = settings?.analysis.profileSource;
	const pendingSource = mutation.variables;
	const saving = mutation.isPending;
	const twitter6551 = settings?.providers.twitter6551;

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
			{settings ? (
				<div className="border-t border-[var(--line)]">
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
									<span>6551 Twitter API</span>
								</div>
								<p className="mt-1 break-all text-[13px] text-[var(--ink-soft)]">
									{twitter6551?.baseUrl} · {twitter6551?.tokenEnv}
								</p>
							</div>
							<span
								className={cx(
									"inline-flex w-fit items-center gap-1.5 rounded-full border px-3 py-1 text-[13px] font-bold",
									twitter6551?.tokenDetected
										? "border-[color:color-mix(in_srgb,#22c55e_45%,var(--line))] text-[var(--ink)]"
										: "border-[var(--line)] text-[var(--ink-soft)]",
								)}
							>
								<CheckCircle2 className="size-4" strokeWidth={2} />
								{twitter6551?.tokenDetected ? "Token detected" : "No token"}
							</span>
						</div>
					</section>
				</div>
			) : settingsQuery.isFetching ? (
				<div className={statusCopyClass}>Loading settings...</div>
			) : null}
		</section>
	);
}
