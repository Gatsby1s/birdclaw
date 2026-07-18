import { describe, expect, it } from "vitest";
import { injectTopicHeadings } from "#/lib/period-digest-markdown";

const topics = [
	{ title: "Kimi K3", tweetIds: ["101010101010"] },
	{ title: "Risk control", tweetIds: ["202020202020"] },
];

describe("injectTopicHeadings", () => {
	it("places topic headings before the first matching discussion bullets only", () => {
		const markdown = [
			"**大家在聊什么**",
			"",
			"- First Kimi point (101010101010).",
			"",
			"- More Kimi detail (101010101010).",
			"",
			"- Risk discussion (202020202020).",
			"",
			"**重要链接分享**",
			"",
			"- Repeated Kimi source (101010101010).",
		].join("\n");

		const result = injectTopicHeadings(markdown, topics);

		expect(result).toContain(
			"### Kimi K3\n\n- First Kimi point (101010101010).",
		);
		expect(result).toContain(
			"### Risk control\n\n- Risk discussion (202020202020).",
		);
		expect(result.match(/### Kimi K3/g)).toHaveLength(1);
		expect(result.indexOf("### Kimi K3")).toBeLessThan(
			result.indexOf("**重要链接分享**"),
		);
	});

	it("matches a citation on a bullet continuation line", () => {
		const markdown =
			"## What people are talking about\n\n- A wrapped discussion\n  with its citation (tweet_101010101010).";

		expect(injectTopicHeadings(markdown, [topics[0]!])).toContain(
			"### Kimi K3\n\n- A wrapped discussion",
		);
	});

	it("never moves an unmatched topic into a later links section", () => {
		const markdown =
			"## What people are talking about\n\n- Unrelated discussion (tweet_303030303030).\n\n## Important links shared\n\n- Kimi source (tweet_101010101010).";

		expect(injectTopicHeadings(markdown, [topics[0]!])).toBe(markdown);
	});

	it("does not duplicate existing Markdown or bold bullet topic headings", () => {
		const existingMarkdown =
			"## What people are talking about\n\n### Kimi K3\n\n- Detail (101010101010).";
		const boldBullet =
			"## What people are talking about\n\n- **Kimi：** Detail (101010101010).";

		expect(
			injectTopicHeadings(existingMarkdown, [topics[0]!]).match(/### Kimi K3/g),
		).toHaveLength(1);
		expect(injectTopicHeadings(boldBullet, [topics[0]!])).toBe(boldBullet);
	});

	it("keeps a differently worded topic heading already attached to a bullet", () => {
		const markdown =
			"## What people are talking about\n\n### Model release discussion\n\n- Detail (tweet_101010101010).";

		expect(injectTopicHeadings(markdown, [topics[0]!])).toBe(markdown);
	});

	it("skips an ambiguous citation shared by multiple topics", () => {
		const markdown =
			"## What people are talking about\n\n- Shared evidence (tweet_101010101010).";
		const sharedTopics = [
			{ title: "First", tweetIds: ["101010101010"] },
			{ title: "Second", tweetIds: ["101010101010"] },
		];

		expect(injectTopicHeadings(markdown, sharedTopics)).toBe(markdown);
	});

	it("keeps topic matching in structured order", () => {
		const markdown = [
			"## What people are talking about",
			"",
			"- Risk appears first (202020202020).",
			"",
			"- Kimi appears later (101010101010).",
		].join("\n");

		const result = injectTopicHeadings(markdown, topics);

		expect(result).toContain("### Kimi K3");
		expect(result).not.toContain("### Risk control");
	});

	it("normalizes a topic title to one line and preserves CRLF", () => {
		const markdown =
			"## What people are talking about\r\n\r\n- Detail (tweet_101010101010).\r\n";
		const result = injectTopicHeadings(markdown, [
			{ title: "  Kimi，\n   K3  ", tweetIds: ["101010101010"] },
		]);

		expect(result).toContain("### Kimi， K3\r\n\r\n- Detail");
		expect(result).not.toMatch(/(?<!\r)\n/);
	});
});
