import {
	ChevronLeft,
	ChevronRight,
	ExternalLink,
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
import type { TweetMediaItem } from "#/lib/types";
import { cx } from "#/lib/ui";

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

export function TweetMediaViewer({
	initialIndex,
	items,
	onClose,
}: {
	initialIndex: number;
	items: TweetMediaItem[];
	onClose: () => void;
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
	const selectedVideoUrl =
		selectedItem?.type === "video" || selectedItem?.type === "gif"
			? (selectedItem.variants?.[0]?.url ?? playableVideoUrl(selectedItem.url))
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
				className="absolute inset-0 flex items-center justify-center overflow-hidden px-2 py-12 sm:px-16 sm:py-14"
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

			<div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-full bg-black/60 p-1 sm:bottom-auto sm:right-4 sm:top-4">
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
					className="absolute right-2 top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-black/60 hover:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white sm:right-4"
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

function playableVideoUrl(url: string) {
	try {
		const parsed = new URL(url);
		if (parsed.hostname === "video.twimg.com") return url;
		return /\.(?:mp4|m3u8)(?:$|[?#])/i.test(parsed.pathname) ? url : undefined;
	} catch {
		return /\.(?:mp4|m3u8)(?:$|[?#])/i.test(url) ? url : undefined;
	}
}
