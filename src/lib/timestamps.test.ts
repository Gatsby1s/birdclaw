// @vitest-environment node
import { describe, expect, it } from "vitest";
import { normalizeTimestampToIso } from "./timestamps";

describe("timestamp normalization", () => {
	it("normalizes Twitter API dates to ISO strings", () => {
		expect(normalizeTimestampToIso("Tue Jun 23 06:06:01 +0000 2026")).toBe(
			"2026-06-23T06:06:01.000Z",
		);
	});

	it("preserves unparseable timestamps", () => {
		expect(normalizeTimestampToIso("not a date")).toBe("not a date");
	});
});
