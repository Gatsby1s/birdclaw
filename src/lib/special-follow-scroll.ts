export interface SpecialFollowCardGeometry {
	id: string;
	top: number;
	bottom: number;
}

const READ_LINE_INSET_PX = 24;

export function selectSpecialFollowReadAnchor(
	cards: readonly SpecialFollowCardGeometry[],
	visibleTop: number,
) {
	const readLine = visibleTop + READ_LINE_INSET_PX;
	return cards.find((card) => card.bottom > readLine) ?? cards.at(-1) ?? null;
}

export function specialFollowRestoreDelta({
	cardTop,
	visibleTop,
	savedPixelOffset,
}: {
	cardTop: number;
	visibleTop: number;
	savedPixelOffset: number;
}) {
	return cardTop - (visibleTop + savedPixelOffset);
}

export function specialFollowPixelOffset(cardTop: number, visibleTop: number) {
	return Math.round(cardTop - visibleTop);
}

export function changedEnoughToPersist(
	previous: { id: string; pixelOffset: number } | null,
	next: { id: string; pixelOffset: number },
	minimumOffsetChange = 32,
) {
	return (
		!previous ||
		previous.id !== next.id ||
		Math.abs(previous.pixelOffset - next.pixelOffset) >= minimumOffsetChange
	);
}
