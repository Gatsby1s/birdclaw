import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
	ReferenceCollectionPrint,
	ReferenceTweetPrint,
	type ReferenceCollectionTweet,
} from "./ReferenceCollectionPrint";

const tweet: ReferenceCollectionTweet = {
	id: "tweet_1",
	author: "alice",
	name: "Alice",
	createdAt: "2026-08-12T08:00:00.000Z",
	text: "Main source text.",
	media: [],
	quotedTweet: {
		author: "bob",
		name: "Bob",
		createdAt: "2026-08-12T07:00:00.000Z",
		text: "Quoted context only for direct tweet printing.",
	},
};

describe("reference collection print", () => {
	afterEach(cleanup);

	it("keeps quoted context scoped to direct tweet printing", () => {
		const { rerender } = render(
			<ReferenceCollectionPrint
				coverTitle="Reference collection"
				documentSummary="Summary"
				documentTitle="Document"
				groups={[
					{
						section: "Sources",
						title: "Topic",
						summary: "Topic summary",
						tweetIds: ["tweet_1"],
					},
				]}
				metadata={[]}
				testId="reference-collection"
				tweets={[tweet]}
			/>,
		);

		expect(
			within(screen.getByTestId("reference-collection")).queryByText(
				"Quoted context only for direct tweet printing.",
			),
		).toBeNull();

		rerender(<ReferenceTweetPrint sourceId="direct-print" tweet={tweet} />);
		expect(
			within(screen.getByLabelText("可打印推文")).getByText(
				"Quoted context only for direct tweet printing.",
			),
		).toBeInTheDocument();
	});

	it("prints only the numeric score beside a referenced tweet author", () => {
		render(
			<ReferenceCollectionPrint
				coverTitle="Reference collection"
				documentSummary="Summary"
				documentTitle="Document"
				groups={[
					{
						section: "Sources",
						title: "Topic",
						summary: "Topic summary",
						tweetIds: ["tweet_1"],
					},
				]}
				metadata={[]}
				scores={{ "1": 8 }}
				testId="scored-reference-collection"
				tweets={[tweet]}
			/>,
		);

		const collection = within(
			screen.getByTestId("scored-reference-collection"),
		);
		expect(
			collection.getByText("8", { selector: ".today-reference-score" }),
		).toBeInTheDocument();
		expect(collection.queryByText("评分依据")).toBeNull();
		expect(collection.queryByText("判断理由")).toBeNull();
		expect(collection.queryByText("通俗解释")).toBeNull();
	});
});
