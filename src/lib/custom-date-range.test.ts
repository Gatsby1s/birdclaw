import { describe, expect, it } from "vitest";
import {
	dateTimeLocalValue,
	defaultCustomDateRange,
	normalizeCustomDateRange,
} from "./custom-date-range";

describe("custom date range", () => {
	it("normalizes a valid range and rejects incomplete or reversed values", () => {
		expect(
			normalizeCustomDateRange(
				"2026-07-10T09:15:00.000Z",
				"2026-07-10T11:45:00.000Z",
			),
		).toEqual({
			since: "2026-07-10T09:15:00.000Z",
			until: "2026-07-10T11:45:00.000Z",
		});
		expect(
			normalizeCustomDateRange(undefined, "2026-07-10T11:45:00.000Z"),
		).toBeNull();
		expect(
			normalizeCustomDateRange(
				"2026-07-10T11:45:00.000Z",
				"2026-07-10T09:15:00.000Z",
			),
		).toBeNull();
	});

	it("defaults to the previous 24 hours and formats local date-time inputs", () => {
		const now = new Date("2026-07-18T13:30:00.000Z");
		expect(defaultCustomDateRange(now)).toEqual({
			since: "2026-07-17T13:30:00.000Z",
			until: "2026-07-18T13:30:00.000Z",
		});

		const localValue = dateTimeLocalValue(now.toISOString());
		expect(new Date(localValue).toISOString()).toBe(now.toISOString());
	});
});
