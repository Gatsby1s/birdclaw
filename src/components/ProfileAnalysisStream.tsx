import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, Sparkles } from "lucide-react";
import { useCallback, useState } from "react";
import { MarkdownViewer } from "#/components/MarkdownViewer";
import { type NdjsonRunContext, useNdjsonRun } from "#/components/useNdjsonRun";
import {
	isTerminalStreamEvent,
	profileAnalysisStreamEventSchema,
} from "#/lib/client-stream-contracts";
import type {
	ProfileAnalysisContext,
	ProfileAnalysisRunResult,
	ProfileAnalysisStreamEvent,
} from "#/lib/profile-analysis";
import { errorCopyClass } from "#/lib/ui";

import {
	DEFAULT_PROFILE_ANALYSIS_LIMITS,
	applyHydratedProfilesToProfileAnalysisContext,
	cleanProfileHandle,
	hydrateProfileAnalysisProfiles,
	profileAnalysisUrl,
} from "#/components/ProfileAnalysisClient";
export {
	DEFAULT_PROFILE_ANALYSIS_LIMITS,
	cleanProfileHandle,
	formatProfileAnalysisCounts,
	profileAnalysisRequestError,
	profileAnalysisUrl,
} from "#/components/ProfileAnalysisClient";

export interface ProfileAnalysisState {
	context: ProfileAnalysisContext | null;
	error: string | null;
	loading: boolean;
	markdown: string;
	result: ProfileAnalysisRunResult | null;
	run: (refresh?: boolean, overrideHandle?: string) => void;
	status: string;
}

function profilePrematureEofError() {
	return new Error(
		"Profile analysis connection closed before completion. Retry to continue.",
	);
}

function profileStreamError(cause: unknown) {
	return cause instanceof Error ? cause.message : "Analysis failed";
}

export function useProfileAnalysisStream(handle: string): ProfileAnalysisState {
	const queryClient = useQueryClient();
	const [markdown, setMarkdown] = useState("");
	const [context, setContext] = useState<ProfileAnalysisContext | null>(null);
	const [result, setResult] = useState<ProfileAnalysisRunResult | null>(null);
	const [status, setStatus] = useState("Ready");

	const onStart = useCallback(() => {
		setMarkdown("");
		setContext(null);
		setResult(null);
		setStatus("Starting profile analysis");
	}, []);
	const request = useCallback(
		(signal: AbortSignal, trimmed: string, refresh: boolean) =>
			fetch(
				profileAnalysisUrl(trimmed, {
					refresh,
					...DEFAULT_PROFILE_ANALYSIS_LIMITS,
				}),
				{ signal },
			),
		[],
	);
	const onEvent = useCallback(
		(event: ProfileAnalysisStreamEvent, runContext: NdjsonRunContext) => {
			const hydrateContext = (
				nextContext: ProfileAnalysisContext,
				nextResult?: ProfileAnalysisRunResult,
			) => {
				void hydrateProfileAnalysisProfiles({
					queryClient,
					context: nextContext,
					analysis: nextResult?.analysis,
					markdown: nextResult?.markdown,
				})
					.then((profiles) => {
						if (!runContext.isActive()) return;
						if (profiles.length === 0) return;
						setContext((current) =>
							current
								? applyHydratedProfilesToProfileAnalysisContext(
										current,
										profiles,
									)
								: current,
						);
						setResult((current) => {
							if (!current) return current;
							const mergedContext =
								applyHydratedProfilesToProfileAnalysisContext(
									current.context,
									profiles,
								);
							return mergedContext === current.context
								? current
								: { ...current, context: mergedContext };
						});
					})
					.catch(() => {
						// Profile hover hydration is best-effort; analysis remains usable.
					});
			};
			if (event.type === "status") {
				setStatus(
					event.detail ? `${event.label} · ${event.detail}` : event.label,
				);
			} else if (event.type === "start") {
				setContext(event.context);
				setStatus(
					event.cached ? "Loading cached analysis" : "Summarizing profile",
				);
				hydrateContext(event.context);
			} else if (event.type === "delta") {
				setMarkdown((current) => current + event.delta);
			} else if (event.type === "done") {
				setResult(event.result);
				setContext(event.result.context);
				setMarkdown(event.result.markdown);
				setStatus(event.result.cached ? "Cached" : "Complete");
				hydrateContext(event.result.context, event.result);
			} else if (event.type === "error") {
				throw new Error(event.error);
			}
		},
		[queryClient],
	);
	const {
		error,
		loading,
		run: runStream,
	} = useNdjsonRun({
		schema: profileAnalysisStreamEventSchema,
		request,
		onStart,
		onEvent,
		isTerminal: isTerminalStreamEvent,
		errorLabel: "Profile analysis failed",
		emptyBodyMessage: "Profile analysis failed: empty response body",
		prematureEofError: profilePrematureEofError,
		formatError: profileStreamError,
	});
	const run = useCallback(
		(refresh = false, overrideHandle?: string) => {
			const trimmed = cleanProfileHandle(overrideHandle ?? handle);
			if (trimmed) runStream(trimmed, refresh);
		},
		[handle, runStream],
	);

	return { context, error, loading, markdown, result, run, status };
}

export function ProfileAnalysisStatusLine({
	analysis,
	className = "",
}: {
	analysis: ProfileAnalysisState;
	className?: string;
}) {
	return (
		<div
			className={`flex items-center gap-2 text-[13px] font-medium text-[var(--ink-soft)] ${className}`}
		>
			{analysis.loading ? (
				<Loader2 className="size-4 animate-spin" strokeWidth={1.8} />
			) : analysis.result ? (
				<CheckCircle2 className="size-4" strokeWidth={1.8} />
			) : (
				<Sparkles className="size-4" strokeWidth={1.8} />
			)}
			<span>{analysis.status}</span>
		</div>
	);
}

export function ProfileAnalysisOutput({
	analysis,
	emptyLabel = "No profile selected.",
}: {
	analysis: ProfileAnalysisState;
	emptyLabel?: string;
}) {
	return (
		<>
			{analysis.error ? (
				<div className={errorCopyClass}>{analysis.error}</div>
			) : null}

			{analysis.markdown ? (
				<div className="max-w-3xl">
					<MarkdownViewer
						context={analysis.context}
						markdown={analysis.markdown}
					/>
				</div>
			) : (
				<div className="rounded-[8px] border border-[var(--line)] bg-[var(--panel)] p-6 text-[14px] text-[var(--ink-soft)]">
					{emptyLabel}
				</div>
			)}
		</>
	);
}
