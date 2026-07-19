import { describe, expect, it } from "vitest";
import { resolveDiscussDateRange } from "./discuss-date-range";

describe("discuss date range", () => {
	const now = new Date("2026-07-18T13:30:00.000Z");

	it("keeps all-time searches unbounded", () => {
		expect(resolveDiscussDateRange("all", now)).toEqual({});
	});

	it("resolves rolling 24-hour and week windows", () => {
		expect(resolveDiscussDateRange("24h", now)).toEqual({
			since: "2026-07-17T13:30:00.000Z",
			until: "2026-07-18T13:30:00.000Z",
		});
		expect(resolveDiscussDateRange("week", now)).toEqual({
			since: "2026-07-11T13:30:00.000Z",
			until: "2026-07-18T13:30:00.000Z",
		});
	});

	it("resolves today and yesterday at local day boundaries", () => {
		const today = resolveDiscussDateRange("today", now);
		const yesterday = resolveDiscussDateRange("yesterday", now);

		expect(today.until).toBe(now.toISOString());
		expect(new Date(today.since ?? "").getHours()).toBe(0);
		expect(yesterday.until).toBe(today.since);
		expect(new Date(yesterday.since ?? "").getHours()).toBe(0);
		expect(new Date(yesterday.since ?? "").getTime()).toBeLessThan(
			new Date(yesterday.until ?? "").getTime(),
		);
	});

	it("uses an explicit custom range", () => {
		expect(
			resolveDiscussDateRange("custom", now, {
				since: "2026-07-10T09:15:00.000Z",
				until: "2026-07-10T11:45:00.000Z",
			}),
		).toEqual({
			since: "2026-07-10T09:15:00.000Z",
			until: "2026-07-10T11:45:00.000Z",
		});
		expect(resolveDiscussDateRange("custom", now, {})).toEqual({});
	});
});
