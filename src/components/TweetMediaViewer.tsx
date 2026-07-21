import {
	Bookmark,
	ChevronLeft,
	ChevronRight,
	ExternalLink,
	Heart,
	Minus,
	Plus,
	RotateCcw,
	X,
} from "lucide-react";
import {
	type MouseEvent as ReactMouseEvent,
	type PointerEvent as ReactPointerEvent,
	type WheelEvent as ReactWheelEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { formatCompactNumber, formatExactTimestamp } from "#/lib/present";
import { playableTweetVideoUrl } from "#/lib/tweet-media";
import type { EmbeddedTweet, TweetMediaItem } from "#/lib/types";
import { cx } from "#/lib/ui";
import { AvatarChip } from "./AvatarChip";
import { TweetRichText } from "./TweetRichText";

const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
const ZOOM_STEP = 0.5;

type Pan = { x: number; y: number };

type DragState = {
	pointerId: number;
	startX: number;
	startY: number;
	originX: number;
	originY: number;
	moved: boolean;
};

export type TweetMediaViewerTweet = Pick<
	EmbeddedTweet,
	| "id"
	| "text"
	| "createdAt"
	| "likeCount"
	| "bookmarked"
	| "liked"
	| "author"
	| "entities"
> & {
	hiddenUrlRanges?: Array<{ start: number; end: number }>;
	permalink?: string | null;
};

export function TweetMediaViewer({
	initialIndex,
	items,
	onClose,
	tweet,
}: {
	initialIndex: number;
	items: TweetMediaItem[];
	onClose: () => void;
	tweet?: TweetMediaViewerTweet;
}) {
	const [selectedIndex, setSelectedIndex] = useState(initialIndex);
	const [zoom, setZoom] = useState(MIN_ZOOM);
	const [pan, setPan] = useState<Pan>({ x: 0, y: 0 });
	const [dragging, setDragging] = useState(false);
	const canvasRef = useRef<HTMLDivElement>(null);
	const mediaRef = useRef<HTMLImageElement>(null);
	const dialogRef = useRef<HTMLDivElement>(null);
	const dragRef = useRef<DragState | null>(null);
	const suppressClickRef = useRef(false);

	const selectedItem = items[selectedIndex] ?? items[0];
	const isImage = selectedItem?.type === "image";
	const selectedVideoUrl = selectedItem
		? playableTweetVideoUrl(selectedItem)
		: null;

	const resetView = useCallback(() => {
		setZoom(MIN_ZOOM);
		setPan({ x: 0, y: 0 });
	}, []);

	const selectMedia = useCallback(
		(index: number) => {
			if (index < 0 || index >= items.length) return;
			setSelectedIndex(index);
			resetView();
		},
		[items.length, resetView],
	);

	const clampPan = useCallback((nextPan: Pan, nextZoom: number) => {
		const canvas = canvasRef.current;
		const media = mediaRef.current;
		if (!canvas || !media || nextZoom <= MIN_ZOOM) {
			return { x: 0, y: 0 };
		}

		const maxX = Math.max(
			0,
			(media.clientWidth * nextZoom - canvas.clientWidth) / 2,
		);
		const maxY = Math.max(
			0,
			(media.clientHeight * nextZoom - canvas.clientHeight) / 2,
		);
		return {
			x: Math.max(-maxX, Math.min(maxX, nextPan.x)),
			y: Math.max(-maxY, Math.min(maxY, nextPan.y)),
		};
	}, []);

	const zoomTo = useCallback(
		(nextZoom: number) => {
			const clampedZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoom));
			setZoom(clampedZoom);
			setPan((currentPan) => clampPan(currentPan, clampedZoom));
		},
		[clampPan],
	);

	useEffect(() => {
		const previousOverflow = document.body.style.overflow;
		const previousScrollbarGutter =
			document.documentElement.style.scrollbarGutter;
		const previousFocus =
			document.activeElement instanceof HTMLElement
				? document.activeElement
				: null;
		document.body.style.overflow = "hidden";
		document.documentElement.style.scrollbarGutter = "auto";
		dialogRef.current?.focus();

		return () => {
			document.body.style.overflow = previousOverflow;
			document.documentElement.style.scrollbarGutter = previousScrollbarGutter;
			previousFocus?.focus();
		};
	}, []);

	useEffect(() => {
		function handleKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") {
				event.preventDefault();
				onClose();
				return;
			}
			if (event.key === "ArrowLeft") {
				event.preventDefault();
				selectMedia(selectedIndex - 1);
				return;
			}
			if (event.key === "ArrowRight") {
				event.preventDefault();
				selectMedia(selectedIndex + 1);
				return;
			}
			if (!isImage) return;
			if (event.key === "+" || event.key === "=") {
				event.preventDefault();
				zoomTo(zoom + ZOOM_STEP);
			} else if (event.key === "-") {
				event.preventDefault();
				zoomTo(zoom - ZOOM_STEP);
			} else if (event.key === "0") {
				event.preventDefault();
				resetView();
			}
		}

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [isImage, onClose, resetView, selectMedia, selectedIndex, zoom, zoomTo]);

	if (!selectedItem) return null;

	function handlePointerDown(event: ReactPointerEvent<HTMLImageElement>) {
		if (zoom <= MIN_ZOOM || event.button !== 0) return;
		event.stopPropagation();
		event.currentTarget.setPointerCapture(event.pointerId);
		dragRef.current = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			originX: pan.x,
			originY: pan.y,
			moved: false,
		};
		setDragging(true);
	}

	function handlePointerMove(event: ReactPointerEvent<HTMLImageElement>) {
		const drag = dragRef.current;
		if (!drag || drag.pointerId !== event.pointerId) return;
		event.stopPropagation();
		const deltaX = event.clientX - drag.startX;
		const deltaY = event.clientY - drag.startY;
		if (Math.abs(deltaX) + Math.abs(deltaY) > 4) drag.moved = true;
		setPan(
			clampPan({ x: drag.originX + deltaX, y: drag.originY + deltaY }, zoom),
		);
	}

	function finishPointerDrag(event: ReactPointerEvent<HTMLImageElement>) {
		const drag = dragRef.current;
		if (!drag || drag.pointerId !== event.pointerId) return;
		event.stopPropagation();
		suppressClickRef.current = drag.moved;
		dragRef.current = null;
		setDragging(false);
	}

	function handleImageClick(event: ReactMouseEvent<HTMLImageElement>) {
		event.stopPropagation();
		if (suppressClickRef.current) {
			suppressClickRef.current = false;
			return;
		}
		if (zoom === MIN_ZOOM) {
			zoomTo(2);
		} else {
			resetView();
		}
	}

	function handleWheel(event: ReactWheelEvent<HTMLDivElement>) {
		if (!isImage) return;
		event.preventDefault();
		event.stopPropagation();
		zoomTo(zoom + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
	}

	return createPortal(
		<div
			aria-label="Tweet media viewer"
			aria-modal="true"
			className="fixed inset-0 z-[100] h-dvh w-dvw overflow-hidden bg-black text-white outline-none"
			onClick={(event) => {
				event.stopPropagation();
				if (event.currentTarget === event.target) onClose();
			}}
			onFocus={(event) => event.stopPropagation()}
			ref={dialogRef}
			role="dialog"
			tabIndex={-1}
		>
			<div
				className="absolute inset-y-0 left-0 right-0 flex items-center justify-center overflow-hidden px-2 py-12 sm:px-16 sm:py-14 lg:right-[380px]"
				onClick={(event) => {
					event.stopPropagation();
					if (event.currentTarget === event.target) onClose();
				}}
				onWheel={handleWheel}
				ref={canvasRef}
			>
				{isImage ? (
					<img
						alt={selectedItem.altText ?? "Tweet media"}
						className={cx(
							"block max-h-full max-w-full select-none object-contain will-change-transform",
							zoom === MIN_ZOOM
								? "cursor-zoom-in"
								: dragging
									? "cursor-grabbing"
									: "cursor-grab",
							!dragging && "transition-transform duration-100",
						)}
						draggable={false}
						onClick={handleImageClick}
						onPointerCancel={finishPointerDrag}
						onPointerDown={handlePointerDown}
						onPointerMove={handlePointerMove}
						onPointerUp={finishPointerDrag}
						ref={mediaRef}
						src={selectedItem.url}
						style={{
							touchAction: zoom > MIN_ZOOM ? "none" : "manipulation",
							transform: `translate3d(${String(pan.x)}px, ${String(pan.y)}px, 0) scale(${String(zoom)})`,
						}}
					/>
				) : selectedVideoUrl ? (
					<video
						autoPlay={selectedItem.type === "gif"}
						className="max-h-full max-w-full"
						controls
						loop={selectedItem.type === "gif"}
						muted={selectedItem.type === "gif"}
						onClick={(event) => event.stopPropagation()}
						playsInline
						poster={selectedItem.thumbnailUrl}
						src={selectedVideoUrl}
					/>
				) : (
					<div
						className="grid min-h-64 min-w-72 place-items-center gap-3 rounded-2xl border border-white/20 bg-neutral-950 p-6"
						onClick={(event) => event.stopPropagation()}
					>
						<span>
							{selectedItem.type === "video"
								? "Video preview unavailable"
								: selectedItem.type === "gif"
									? "GIF preview unavailable"
									: "Media preview unavailable"}
						</span>
						<a
							className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-black hover:bg-neutral-200"
							href={selectedItem.url}
							rel="noreferrer"
							target="_blank"
						>
							Open media
						</a>
					</div>
				)}
			</div>
			{tweet ? <TweetMediaViewerDetails tweet={tweet} /> : null}

			<div className="absolute left-3 top-3 flex items-center gap-2 sm:left-4 sm:top-4">
				<button
					aria-label="Close media viewer"
					className="grid size-10 place-items-center rounded-full bg-black/60 text-white hover:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
					onClick={onClose}
					type="button"
				>
					<X className="size-5" strokeWidth={2} />
				</button>
				{items.length > 1 ? (
					<span className="rounded-full bg-black/60 px-3 py-2 text-[13px] font-semibold tabular-nums">
						{selectedIndex + 1} / {items.length}
					</span>
				) : null}
			</div>

			<div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-full bg-black/60 p-1 sm:bottom-auto sm:right-4 sm:top-4 lg:right-[396px]">
				{isImage ? (
					<>
						<button
							aria-label="Zoom out"
							className="grid size-9 place-items-center rounded-full hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40"
							disabled={zoom <= MIN_ZOOM}
							onClick={() => zoomTo(zoom - ZOOM_STEP)}
							type="button"
						>
							<Minus className="size-4" strokeWidth={2} />
						</button>
						<span
							aria-live="polite"
							className="min-w-12 text-center text-[12px] font-semibold tabular-nums"
						>
							{Math.round(zoom * 100)}%
						</span>
						<button
							aria-label="Zoom in"
							className="grid size-9 place-items-center rounded-full hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40"
							disabled={zoom >= MAX_ZOOM}
							onClick={() => zoomTo(zoom + ZOOM_STEP)}
							type="button"
						>
							<Plus className="size-4" strokeWidth={2} />
						</button>
						<button
							aria-label="Reset zoom"
							className="grid size-9 place-items-center rounded-full hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40"
							disabled={zoom === MIN_ZOOM}
							onClick={resetView}
							type="button"
						>
							<RotateCcw className="size-4" strokeWidth={2} />
						</button>
					</>
				) : null}
				<a
					aria-label="Open original media"
					className="grid size-9 place-items-center rounded-full hover:bg-white/15"
					href={selectedItem.url}
					rel="noreferrer"
					target="_blank"
				>
					<ExternalLink className="size-4" strokeWidth={2} />
				</a>
			</div>

			{selectedIndex > 0 ? (
				<button
					aria-label="Previous media"
					className="absolute left-2 top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-black/60 hover:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white sm:left-4"
					onClick={() => selectMedia(selectedIndex - 1)}
					type="button"
				>
					<ChevronLeft className="size-6" strokeWidth={2} />
				</button>
			) : null}
			{selectedIndex < items.length - 1 ? (
				<button
					aria-label="Next media"
					className="absolute right-2 top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-black/60 hover:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white sm:right-4 lg:right-[396px]"
					onClick={() => selectMedia(selectedIndex + 1)}
					type="button"
				>
					<ChevronRight className="size-6" strokeWidth={2} />
				</button>
			) : null}
		</div>,
		document.body,
	);
}

function TweetMediaViewerDetails({ tweet }: { tweet: TweetMediaViewerTweet }) {
	const originalTweetUrl = tweet.permalink ?? defaultTweetPermalink(tweet);
	const likeCount = tweet.likeCount ?? 0;

	return (
		<aside
			aria-label="Tweet details"
			className="absolute inset-y-0 right-0 hidden w-[380px] flex-col border-l border-white/15 bg-[#16181c] text-white lg:flex"
		>
			<header className="flex h-14 shrink-0 items-center border-b border-white/12 px-5 text-[17px] font-bold">
				Post
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
				<div className="flex items-center gap-3">
					<AvatarChip
						avatarUrl={tweet.author.avatarUrl}
						hue={tweet.author.avatarHue}
						name={tweet.author.displayName}
						profileId={tweet.author.id}
					/>
					<div className="min-w-0">
						<a
							className="block truncate text-[15px] font-bold text-white hover:underline"
							href={`/profiles/${encodeURIComponent(tweet.author.handle)}`}
						>
							{tweet.author.displayName}
						</a>
						<span className="block truncate text-[14px] text-neutral-400">
							@{tweet.author.handle}
						</span>
					</div>
				</div>
				<TweetRichText
					className="mt-4 whitespace-pre-wrap break-words text-[15px] leading-6 text-white [overflow-wrap:anywhere]"
					entities={tweet.entities}
					hiddenUrlRanges={tweet.hiddenUrlRanges}
					text={tweet.text}
				/>
				<time
					className="mt-4 block text-[14px] text-neutral-400"
					dateTime={tweet.createdAt}
					title={formatExactTimestamp(tweet.createdAt)}
				>
					{formatMediaViewerTimestamp(tweet.createdAt)}
				</time>
				{likeCount > 0 || tweet.bookmarked ? (
					<div className="mt-4 flex items-center gap-4 border-y border-white/12 py-3 text-[14px]">
						{likeCount > 0 ? (
							<span
								className={cx(
									"inline-flex items-center gap-2",
									tweet.liked && "text-pink-400",
								)}
							>
								<Heart
									className="size-4"
									fill={tweet.liked ? "currentColor" : "none"}
									strokeWidth={1.8}
								/>
								<span>{formatCompactNumber(likeCount)} Likes</span>
							</span>
						) : null}
						{tweet.bookmarked ? (
							<span className="inline-flex items-center gap-2 text-neutral-200">
								<Bookmark
									className="size-4"
									fill="currentColor"
									strokeWidth={1.8}
								/>
								<span>Saved</span>
							</span>
						) : null}
					</div>
				) : null}
				<div className="mt-4 flex flex-wrap gap-2">
					{originalTweetUrl ? (
						<a
							aria-label={`Open @${tweet.author.handle} on X`}
							className="inline-flex items-center gap-2 rounded-full border border-white/20 px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-white/10"
							href={originalTweetUrl}
							rel="noreferrer"
							target="_blank"
						>
							<ExternalLink className="size-3.5" strokeWidth={2} />
							Open on X
						</a>
					) : null}
					<a
						className="inline-flex items-center rounded-full border border-white/20 px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-white/10"
						href={`/profiles/${encodeURIComponent(tweet.author.handle)}`}
					>
						Analyse profile
					</a>
				</div>
			</div>
		</aside>
	);
}

function defaultTweetPermalink(tweet: TweetMediaViewerTweet) {
	const handle = tweet.author.handle.trim().replace(/^@/, "");
	if (!handle || !tweet.id) return null;
	return `https://x.com/${encodeURIComponent(handle)}/status/${encodeURIComponent(tweet.id)}`;
}

function formatMediaViewerTimestamp(value: string) {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	const time = new Intl.DateTimeFormat("en", {
		hour: "numeric",
		minute: "2-digit",
	}).format(date);
	const calendarDate = new Intl.DateTimeFormat("en", {
		month: "short",
		day: "numeric",
		year: "numeric",
	}).format(date);
	return `${time} · ${calendarDate}`;
}
