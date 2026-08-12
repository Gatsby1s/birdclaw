import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
	type InfiniteData,
} from "@tanstack/react-query";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { TimelineCard } from "#/components/TimelineCard";
import {
	TimelineFeedHeader,
	TimelineFeedShell,
	TimelineHeaderSubtitle,
} from "#/components/TimelineFeedShell";
import { fetchJson, fetchQueryEnvelope, postAction } from "#/lib/api-client";
import {
	specialFollowFeedResponseSchema,
	specialFollowPositionResponseSchema,
	specialFollowPositionWriteResponseSchema,
} from "#/lib/api-contracts";
import { queryKeys } from "#/lib/query-client";
import {
	changedEnoughToPersist,
	selectSpecialFollowReadAnchor,
	specialFollowPixelOffset,
	specialFollowRestoreDelta,
} from "#/lib/special-follow-scroll";
import type {
	SpecialFollowCursor,
	SpecialFollowFeedMode,
	SpecialFollowFeedResponse,
	SpecialFollowPositionWriteRequest,
	TimelineItem,
} from "#/lib/types";
import { cx, timestampClass } from "#/lib/ui";
import { useSelectedAccountId } from "./account-selection";

const PAGE_SIZE = 24;
const SAVE_DELAY_MS = 2_000;

interface FeedPageParam {
	mode: SpecialFollowFeedMode;
	cursor?: SpecialFollowCursor;
}

function sessionId() {
	return typeof crypto !== "undefined" && "randomUUID" in crypto
		? crypto.randomUUID()
		: `special-follow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function visibleFeedTop(container: HTMLElement | null) {
	if (!container || typeof window === "undefined") return 0;
	const header = container.querySelector<HTMLElement>("header");
	if (!header) return 0;
	const desktop =
		typeof window.matchMedia === "function"
			? window.matchMedia("(min-width: 900px)").matches
			: window.innerWidth >= 900;
	return desktop ? Math.max(0, header.getBoundingClientRect().bottom) : 0;
}

async function savePosition(input: SpecialFollowPositionWriteRequest) {
	const response = await fetch("/api/special-follow-position", {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
	});
	const data: unknown = await response.json().catch(() => null);
	const parsed = specialFollowPositionWriteResponseSchema.safeParse(data);
	if (!parsed.success) throw new Error("阅读位置保存失败");
	if (!response.ok && response.status !== 409) {
		throw new Error("阅读位置保存失败");
	}
	return parsed.data;
}

export function SpecialFollowTimeline({ viewTabs }: { viewTabs: ReactNode }) {
	const queryClient = useQueryClient();
	const headerRef = useRef<HTMLDivElement>(null);
	const feedRef = useRef<HTMLDivElement>(null);
	const restoredRef = useRef(false);
	const userInteractedRef = useRef(false);
	const sessionIdRef = useRef(sessionId());
	const sequenceRef = useRef(0);
	const revisionRef = useRef(0);
	const lastPersistedRef = useRef<{ id: string; pixelOffset: number } | null>(
		null,
	);
	const pendingRef = useRef<{ id: string; pixelOffset: number } | null>(null);
	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const saveChainRef = useRef(Promise.resolve());
	const loadingNewerRef = useRef(false);
	const pendingPrependRef = useRef<{ id: string; top: number } | null>(null);
	const [restored, setRestored] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);

	const statusQuery = useQuery({
		queryKey: queryKeys.status,
		queryFn: ({ signal }) => fetchQueryEnvelope({ signal }),
	});
	const meta = statusQuery.data ?? null;
	const selectedAccountId = useSelectedAccountId(meta?.accounts);
	const positionQuery = useQuery({
		queryKey: [...queryKeys.specialFollowPosition, selectedAccountId ?? "none"],
		queryFn: ({ signal }) => {
			const url = new URL(
				"/api/special-follow-position",
				window.location.origin,
			);
			url.searchParams.set("account", selectedAccountId as string);
			return fetchJson(
				url,
				{ signal },
				specialFollowPositionResponseSchema,
				"阅读位置暂时不可用",
			);
		},
		enabled: Boolean(selectedAccountId),
		staleTime: 0,
		refetchOnMount: "always",
	});

	useEffect(() => {
		revisionRef.current = positionQuery.data?.position?.revision ?? 0;
	}, [positionQuery.data]);

	const feedQuery = useInfiniteQuery<
		SpecialFollowFeedResponse,
		Error,
		InfiniteData<SpecialFollowFeedResponse, FeedPageParam>,
		readonly unknown[],
		FeedPageParam
	>({
		queryKey: [
			...queryKeys.specialFollowFeed,
			selectedAccountId ?? "none",
			"resume",
		],
		initialPageParam: { mode: "resume" } as FeedPageParam,
		queryFn: ({ pageParam, signal }) => {
			const url = new URL("/api/special-follow-feed", window.location.origin);
			url.searchParams.set("account", selectedAccountId as string);
			url.searchParams.set("mode", pageParam.mode);
			url.searchParams.set("limit", String(PAGE_SIZE));
			if (pageParam.cursor) {
				url.searchParams.set("cursorCreatedAt", pageParam.cursor.createdAt);
				url.searchParams.set("cursorTweetId", pageParam.cursor.tweetId);
			}
			return fetchJson(
				url,
				{ signal },
				specialFollowFeedResponseSchema,
				"特别关注动态暂时不可用",
			);
		},
		getNextPageParam: (lastPage): FeedPageParam | undefined =>
			lastPage.page.hasOlder && lastPage.page.olderCursor
				? { mode: "older", cursor: lastPage.page.olderCursor }
				: undefined,
		enabled: Boolean(selectedAccountId) && positionQuery.isSuccess,
		staleTime: 0,
		refetchOnMount: "always",
	});

	const firstPage = feedQuery.data?.pages[0];
	const newerStartCursor =
		firstPage?.page.hasNewer && firstPage.page.newerCursor
			? firstPage.page.newerCursor
			: null;
	const newerQuery = useInfiniteQuery<
		SpecialFollowFeedResponse,
		Error,
		InfiniteData<SpecialFollowFeedResponse, FeedPageParam>,
		readonly unknown[],
		FeedPageParam
	>({
		queryKey: [
			...queryKeys.specialFollowFeed,
			selectedAccountId ?? "none",
			"newer",
			sessionIdRef.current,
			newerStartCursor?.createdAt ?? "none",
			newerStartCursor?.tweetId ?? "none",
		],
		initialPageParam: {
			mode: "newer",
			cursor: newerStartCursor ?? undefined,
		} as FeedPageParam,
		queryFn: async ({ pageParam, signal }) => {
			if (!pageParam.cursor) throw new Error("没有可加载的新动态");
			const url = new URL("/api/special-follow-feed", window.location.origin);
			url.searchParams.set("account", selectedAccountId as string);
			url.searchParams.set("mode", "newer");
			url.searchParams.set("limit", String(PAGE_SIZE));
			url.searchParams.set("cursorCreatedAt", pageParam.cursor.createdAt);
			url.searchParams.set("cursorTweetId", pageParam.cursor.tweetId);
			const response = await fetchJson(
				url,
				{ signal },
				specialFollowFeedResponseSchema,
				"特别关注动态暂时不可用",
			);
			if (loadingNewerRef.current) {
				const cards = [
					...(feedRef.current?.querySelectorAll<HTMLElement>(
						"[data-special-follow-anchor]",
					) ?? []),
				].map((node) => {
					const rect = node.getBoundingClientRect();
					return {
						id: node.dataset.specialFollowAnchor as string,
						top: rect.top,
						bottom: rect.bottom,
					};
				});
				const anchor = selectSpecialFollowReadAnchor(
					cards,
					visibleFeedTop(headerRef.current),
				);
				pendingPrependRef.current = anchor
					? { id: anchor.id, top: anchor.top }
					: null;
			}
			return response;
		},
		getNextPageParam: (lastPage): FeedPageParam | undefined =>
			lastPage.page.hasNewer && lastPage.page.newerCursor
				? { mode: "newer", cursor: lastPage.page.newerCursor }
				: undefined,
		enabled: false,
		staleTime: Infinity,
	});

	const items = useMemo(() => {
		const seen = new Set<string>();
		const merged: TimelineItem[] = [];
		for (const page of [...(newerQuery.data?.pages ?? [])].reverse()) {
			for (const item of page.items) {
				if (seen.has(item.id)) continue;
				seen.add(item.id);
				merged.push(item);
			}
		}
		for (const page of feedQuery.data?.pages ?? []) {
			for (const item of page.items) {
				if (seen.has(item.id)) continue;
				seen.add(item.id);
				merged.push(item);
			}
		}
		return merged;
	}, [feedQuery.data, newerQuery.data]);
	const specialFollowProfileCount = firstPage?.specialFollowProfileCount ?? 0;

	useLayoutEffect(() => {
		restoredRef.current = false;
		userInteractedRef.current = false;
		lastPersistedRef.current = null;
		pendingRef.current = null;
		setRestored(false);
	}, [selectedAccountId]);

	useLayoutEffect(() => {
		if (
			!feedQuery.data ||
			restoredRef.current ||
			positionQuery.isError ||
			feedQuery.isError ||
			positionQuery.isFetching ||
			feedQuery.isFetching
		)
			return;
		const restore = firstPage?.page.restore;
		let cleanupAlignment: (() => void) | undefined;
		if (restore?.resolvedTweetId) {
			const anchor = [
				...(feedRef.current?.querySelectorAll<HTMLElement>(
					"[data-special-follow-anchor]",
				) ?? []),
			].find(
				(node) => node.dataset.specialFollowAnchor === restore.resolvedTweetId,
			);
			if (!anchor) return;
			const align = () => {
				if (userInteractedRef.current) return;
				const top = visibleFeedTop(headerRef.current);
				const delta = specialFollowRestoreDelta({
					cardTop: anchor.getBoundingClientRect().top,
					visibleTop: top,
					savedPixelOffset: restore.pixelOffset,
				});
				if (Math.abs(delta) >= 1) {
					window.scrollBy({ top: delta, behavior: "auto" });
				}
			};
			align();
			if (typeof ResizeObserver !== "undefined") {
				let frame = 0;
				const observer = new ResizeObserver(() => {
					if (frame || userInteractedRef.current) return;
					frame = requestAnimationFrame(() => {
						frame = 0;
						align();
					});
				});
				observer.observe(anchor);
				const timer = setTimeout(() => observer.disconnect(), 2_000);
				cleanupAlignment = () => {
					if (frame) cancelAnimationFrame(frame);
					clearTimeout(timer);
					observer.disconnect();
				};
			}
			lastPersistedRef.current = {
				id: restore.resolvedTweetId,
				pixelOffset: restore.pixelOffset,
			};
		}
		restoredRef.current = true;
		setRestored(true);
		return cleanupAlignment;
	}, [
		feedQuery.data,
		feedQuery.isError,
		feedQuery.isFetching,
		firstPage,
		positionQuery.isError,
		positionQuery.isFetching,
	]);

	const persist = useCallback(
		(candidate: { id: string; pixelOffset: number }, keepalive = false) => {
			if (
				!selectedAccountId ||
				!restoredRef.current ||
				!userInteractedRef.current
			)
				return;
			const body: SpecialFollowPositionWriteRequest = {
				accountId: selectedAccountId,
				anchorTweetId: candidate.id,
				pixelOffset: candidate.pixelOffset,
				clientSessionId: sessionIdRef.current,
				clientSequence: ++sequenceRef.current,
				expectedRevision: revisionRef.current,
			};
			if (keepalive) {
				void fetch("/api/special-follow-position", {
					method: "PATCH",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
					keepalive: true,
				});
				pendingRef.current = null;
				return;
			}
			saveChainRef.current = saveChainRef.current
				.then(async () => {
					const result = await savePosition({
						...body,
						expectedRevision: revisionRef.current,
					});
					revisionRef.current = result.position?.revision ?? 0;
					if (result.conflict) {
						lastPersistedRef.current = result.position
							? {
									id: result.position.anchorTweetId,
									pixelOffset: result.position.pixelOffset,
								}
							: null;
						pendingRef.current = null;
						return;
					}
					lastPersistedRef.current = candidate;
					if (pendingRef.current?.id === candidate.id) {
						pendingRef.current = null;
					}
					setSaveError(null);
					queryClient.setQueryData(
						[...queryKeys.specialFollowPosition, selectedAccountId],
						{
							accountId: selectedAccountId,
							viewKey: "special-follow",
							position: result.position,
						},
					);
				})
				.catch((error: unknown) => {
					setSaveError(
						error instanceof Error ? error.message : "阅读位置保存失败",
					);
				});
		},
		[queryClient, selectedAccountId],
	);

	const capturePosition = useCallback(() => {
		if (!restoredRef.current || !userInteractedRef.current) return;
		const cards = [
			...(feedRef.current?.querySelectorAll<HTMLElement>(
				"[data-special-follow-anchor]",
			) ?? []),
		].map((node) => {
			const rect = node.getBoundingClientRect();
			return {
				id: node.dataset.specialFollowAnchor as string,
				top: rect.top,
				bottom: rect.bottom,
			};
		});
		const top = visibleFeedTop(headerRef.current);
		const anchor = selectSpecialFollowReadAnchor(cards, top);
		if (!anchor) return;
		const candidate = {
			id: anchor.id,
			pixelOffset: specialFollowPixelOffset(anchor.top, top),
		};
		if (!changedEnoughToPersist(lastPersistedRef.current, candidate)) return;
		pendingRef.current = candidate;
		if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
		saveTimerRef.current = setTimeout(() => {
			saveTimerRef.current = null;
			if (pendingRef.current) persist(pendingRef.current);
		}, SAVE_DELAY_MS);
	}, [persist]);

	useLayoutEffect(() => {
		const pending = pendingPrependRef.current;
		if (!pending) return;
		const anchor = [
			...(feedRef.current?.querySelectorAll<HTMLElement>(
				"[data-special-follow-anchor]",
			) ?? []),
		].find((node) => node.dataset.specialFollowAnchor === pending.id);
		pendingPrependRef.current = null;
		if (!anchor) return;
		const delta = anchor.getBoundingClientRect().top - pending.top;
		if (Math.abs(delta) >= 1) {
			window.scrollBy({ top: delta, behavior: "auto" });
		}
		const frame = requestAnimationFrame(capturePosition);
		return () => cancelAnimationFrame(frame);
	}, [capturePosition, newerQuery.data]);

	const loadNewerWithoutDisplacement = useCallback(async () => {
		if (
			!restoredRef.current ||
			!userInteractedRef.current ||
			(!newerQuery.data && !newerStartCursor) ||
			(newerQuery.data && !newerQuery.hasNextPage) ||
			newerQuery.isFetchingNextPage ||
			loadingNewerRef.current
		)
			return;
		loadingNewerRef.current = true;
		try {
			await newerQuery.fetchNextPage();
		} finally {
			loadingNewerRef.current = false;
		}
	}, [newerQuery, newerStartCursor]);

	useEffect(() => {
		if (!restored) return;
		let frame = 0;
		const markInteraction = () => {
			userInteractedRef.current = true;
		};
		const onKey = (event: KeyboardEvent) => {
			if (
				[
					"ArrowDown",
					"ArrowUp",
					"PageDown",
					"PageUp",
					"Home",
					"End",
					" ",
				].includes(event.key)
			) {
				markInteraction();
			}
		};
		const onScroll = () => {
			if (!userInteractedRef.current || frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				if (window.scrollY <= 240) {
					void loadNewerWithoutDisplacement();
				}
				capturePosition();
			});
		};
		const flush = () => {
			if (document.visibilityState === "hidden" && pendingRef.current) {
				persist(pendingRef.current, true);
			}
		};
		const onPageHide = () => {
			if (pendingRef.current) persist(pendingRef.current, true);
		};
		window.addEventListener("wheel", markInteraction, { passive: true });
		window.addEventListener("touchmove", markInteraction, { passive: true });
		window.addEventListener("keydown", onKey);
		window.addEventListener("scroll", onScroll, { passive: true });
		document.addEventListener("visibilitychange", flush);
		window.addEventListener("pagehide", onPageHide);
		return () => {
			if (frame) cancelAnimationFrame(frame);
			window.removeEventListener("wheel", markInteraction);
			window.removeEventListener("touchmove", markInteraction);
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("scroll", onScroll);
			document.removeEventListener("visibilitychange", flush);
			window.removeEventListener("pagehide", onPageHide);
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
			if (pendingRef.current) persist(pendingRef.current);
		};
	}, [capturePosition, loadNewerWithoutDisplacement, persist, restored]);

	const replyMutation = useMutation({
		mutationFn: ({ tweetId, text }: { tweetId: string; text: string }) =>
			postAction({
				kind: "replyTweet",
				accountId: selectedAccountId ?? "acct_primary",
				tweetId,
				text,
			}),
	});
	async function replyToTweet(tweetId: string) {
		const text = window.prompt("Reply text");
		if (!text?.trim()) return;
		await replyMutation
			.mutateAsync({ tweetId, text: text.trim() })
			.catch(() => {});
	}

	const queryError =
		statusQuery.error ?? positionQuery.error ?? feedQuery.error;
	const error = queryError
		? queryError instanceof Error
			? queryError.message
			: "特别关注动态暂时不可用"
		: statusQuery.isSuccess && !selectedAccountId
			? "没有可用的 BirdClaw 账号"
			: null;
	const loading =
		statusQuery.isPending ||
		Boolean(selectedAccountId && positionQuery.isPending) ||
		Boolean(
			selectedAccountId && positionQuery.isSuccess && feedQuery.isPending,
		);
	return (
		<div ref={headerRef} data-special-follow-header>
			<TimelineFeedShell
				header={
					<TimelineFeedHeader
						title="Mentions"
						subtitles={
							<TimelineHeaderSubtitle>
								{specialFollowProfileCount > 0
									? `${String(specialFollowProfileCount)} 个特别关注账号的动态`
									: "像朋友圈一样，只看最重要的人"}
							</TimelineHeaderSubtitle>
						}
						controls={
							<>
								{viewTabs}
								<div className="flex items-center px-4 py-3">
									<span className={timestampClass}>按发布时间倒序</span>
								</div>
							</>
						}
					/>
				}
				notice={
					<>
						{specialFollowProfileCount === 0 && !loading && !error ? (
							<p className="m-0 px-4 pt-3 text-[13px] text-[var(--ink-soft)]">
								<a
									className="font-semibold text-[var(--accent)] hover:underline"
									href="/"
								>
									去首页选择作者
								</a>
								：点作者头像进入资料页，再点“特别关注”。
							</p>
						) : null}
						{saveError || replyMutation.error ? (
							<p className={cx(timestampClass, "m-0 px-4 py-2 text-red-500")}>
								{saveError ?? "回复发送失败"}
							</p>
						) : null}
					</>
				}
				loading={loading}
				loadingLabel="正在恢复上次阅读位置"
				loadingDetail="从云端读取特别关注动态与阅读锚点"
				error={error}
				errorTitle="特别关注动态加载失败"
				onRetry={() => {
					void Promise.all([
						statusQuery.refetch(),
						positionQuery.refetch(),
						feedQuery.refetch(),
					]);
				}}
				empty={!loading && items.length === 0}
				emptyLabel={
					specialFollowProfileCount === 0 ? "还没有特别关注" : "暂时没有动态"
				}
				emptyDetail={
					specialFollowProfileCount === 0
						? "选择重要账号后，他们已有的动态会出现在这里。"
						: "这些账号还没有已归档的动态，新内容归档后会自动出现在这里。"
				}
				hasMore={feedQuery.hasNextPage}
				loadingMore={feedQuery.isFetchingNextPage}
				onLoadMore={() => void feedQuery.fetchNextPage()}
			>
				<div
					aria-busy={newerQuery.isFetchingNextPage}
					aria-hidden={!restored}
					data-special-follow-feed-state={restored ? "restored" : "restoring"}
					ref={feedRef}
					style={{
						overflowAnchor: "none",
						visibility: restored ? "visible" : "hidden",
					}}
				>
					{items.map((item) => (
						<div data-special-follow-anchor={item.id} key={item.id}>
							<TimelineCard item={item} onReply={replyToTweet} />
						</div>
					))}
				</div>
			</TimelineFeedShell>
		</div>
	);
}
