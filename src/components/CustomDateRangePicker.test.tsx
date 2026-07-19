import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dateTimeLocalValue } from "#/lib/custom-date-range";
import { CustomDateRangePicker } from "./CustomDateRangePicker";

describe("CustomDateRangePicker", () => {
	afterEach(cleanup);

	it("syncs its local inputs when a restored route range changes", () => {
		const firstRange = {
			since: "2026-07-10T01:15:00.000Z",
			until: "2026-07-10T03:45:00.000Z",
		};
		const { rerender } = render(
			<CustomDateRangePicker value={firstRange} onApply={vi.fn()} />,
		);
		expect(screen.getByLabelText("From")).toHaveValue(
			dateTimeLocalValue(firstRange.since),
		);
		expect(screen.getByLabelText("To")).toHaveValue(
			dateTimeLocalValue(firstRange.until),
		);

		const secondRange = {
			since: "2026-07-11T00:00:00.000Z",
			until: "2026-07-11T02:30:00.000Z",
		};
		rerender(<CustomDateRangePicker value={secondRange} onApply={vi.fn()} />);
		expect(screen.getByLabelText("From")).toHaveValue(
			dateTimeLocalValue(secondRange.since),
		);
		expect(screen.getByLabelText("To")).toHaveValue(
			dateTimeLocalValue(secondRange.until),
		);
	});
});
