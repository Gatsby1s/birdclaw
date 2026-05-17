import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LinkPreviewCard } from "./LinkPreviewCard";

afterEach(() => {
	cleanup();
});

describe("LinkPreviewCard", () => {
	it("can rerender from a safe URL to an unsafe URL without changing hooks", () => {
		const { container, rerender } = render(
			<LinkPreviewCard
				entry={{
					url: "https://example.com",
					expandedUrl: "https://example.com",
					displayUrl: "example.com",
					start: 0,
					end: 19,
				}}
				index={0}
			/>,
		);

		expect(container.querySelector("a")).toBeInTheDocument();

		expect(() =>
			rerender(
				<LinkPreviewCard
					entry={{
						url: "javascript:alert(1)",
						expandedUrl: "javascript:alert(1)",
						displayUrl: "bad",
						start: 0,
						end: 19,
					}}
					index={0}
				/>,
			),
		).not.toThrow();
		expect(container.querySelector("a")).toBeNull();
	});
});
