import { describe, expect, it } from "vitest";
import {
	changedEnoughToPersist,
	selectSpecialFollowReadAnchor,
	specialFollowPixelOffset,
	specialFollowRestoreDelta,
} from "./special-follow-scroll";

describe("special-follow scroll positioning", () => {
	it("selects the first card that crosses the reading line", () => {
		expect(
			selectSpecialFollowReadAnchor(
				[
					{ id: "newer", top: -300, bottom: 80 },
					{ id: "anchor", top: 80, bottom: 420 },
				],
				64,
			),
		).toMatchObject({ id: "anchor" });
	});

	it("restores the same offset relative to the visible feed top", () => {
		expect(
			specialFollowRestoreDelta({
				cardTop: 420,
				visibleTop: 80,
				savedPixelOffset: 40,
			}),
		).toBe(300);
		expect(specialFollowPixelOffset(120, 80)).toBe(40);
	});

	it("avoids noisy writes for tiny movement within one card", () => {
		expect(
			changedEnoughToPersist(
				{ id: "anchor", pixelOffset: -12 },
				{ id: "anchor", pixelOffset: -30 },
			),
		).toBe(false);
		expect(
			changedEnoughToPersist(
				{ id: "anchor", pixelOffset: -12 },
				{ id: "older", pixelOffset: 20 },
			),
		).toBe(true);
	});
});
