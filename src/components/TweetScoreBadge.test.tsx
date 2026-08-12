import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TweetScoreBadge } from "./TweetScoreBadge";

const score = {
	tweetId: "tweet_1",
	score: 8,
	label: "高信息价值",
	dimensions: {
		informationDelta: 4,
		clearThesis: 2,
		explainedMechanism: 1,
		verifiability: 1,
		clearBoundaries: 0,
	},
	sentiment: "positive" as const,
	assets: ["股票", "加密资产"],
	reason: "帖子给出了新的数据、明确观点，并解释了因果关系。",
	explanation: "作者认为未来十年股票机会更大，但并没有完全否定加密资产。",
	updatedAt: "2026-08-12T08:00:00.000Z",
	cached: false,
};

describe("TweetScoreBadge", () => {
	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

	it("shows only the number until hovered or focused", () => {
		render(<TweetScoreBadge score={score} />);
		const trigger = screen.getByRole("button", { name: /帖子评分 8 分/ });
		expect(trigger).toHaveTextContent(/^8$/);
		expect(trigger).toHaveClass("size-11");
		expect(screen.queryByText("评分依据")).not.toBeInTheDocument();

		fireEvent.focus(trigger);
		expect(screen.getByText("评分依据")).toBeInTheDocument();
		expect(screen.getByText("帖子判断")).toBeInTheDocument();
		expect(screen.getByText("判断理由")).toBeInTheDocument();
		expect(screen.getByText("通俗解释")).toBeInTheDocument();
		expect(screen.queryByText(/Next actions/i)).not.toBeInTheDocument();
	});

	it("supports a mobile-style click and Escape close", () => {
		render(<TweetScoreBadge score={score} />);
		const trigger = screen.getByRole("button", { name: /帖子评分 8 分/ });
		fireEvent.pointerDown(trigger);
		fireEvent.click(trigger);
		expect(screen.getByText("高信息价值")).toBeInTheDocument();
		fireEvent.keyDown(trigger, { key: "Escape" });
		expect(screen.queryByText("高信息价值")).not.toBeInTheDocument();
	});

	it("toggles closed when the same score is clicked twice", () => {
		render(<TweetScoreBadge score={score} />);
		const trigger = screen.getByRole("button", { name: /帖子评分 8 分/ });
		fireEvent.pointerDown(trigger);
		fireEvent.click(trigger);
		expect(screen.getByText("高信息价值")).toBeInTheDocument();
		fireEvent.pointerDown(trigger);
		fireEvent.click(trigger);
		expect(screen.queryByText("高信息价值")).not.toBeInTheDocument();
	});

	it("keeps a tapped score pinned after the pointer leaves", () => {
		vi.useFakeTimers();
		render(<TweetScoreBadge score={score} />);
		const trigger = screen.getByRole("button", { name: /帖子评分 8 分/ });
		fireEvent.pointerDown(trigger);
		fireEvent.click(trigger);
		fireEvent.pointerLeave(trigger.parentElement as HTMLElement);
		act(() => vi.advanceTimersByTime(200));
		expect(screen.getByText("评分依据")).toBeInTheDocument();
	});

	it("closes the previous score card when another score is tapped", () => {
		const otherScore = {
			...score,
			tweetId: "tweet_2",
			score: 6,
			label: "中等信息价值",
		};
		render(
			<>
				<TweetScoreBadge score={score} />
				<TweetScoreBadge score={otherScore} />
			</>,
		);
		fireEvent.click(screen.getByRole("button", { name: /帖子评分 8 分/ }));
		expect(screen.getByText("高信息价值")).toBeInTheDocument();
		const second = screen.getByRole("button", { name: /帖子评分 6 分/ });
		fireEvent.pointerDown(second);
		fireEvent.click(second);
		expect(screen.queryByText("高信息价值")).not.toBeInTheDocument();
		expect(screen.getByText("中等信息价值")).toBeInTheDocument();
	});

	it("keeps only one floating preview open across focus and hover", () => {
		const otherScore = {
			...score,
			tweetId: "tweet_2",
			score: 6,
			label: "中等信息价值",
		};
		render(
			<>
				<TweetScoreBadge score={score} />
				<TweetScoreBadge score={otherScore} />
			</>,
		);
		const first = screen.getByRole("button", { name: /帖子评分 8 分/ });
		const second = screen.getByRole("button", { name: /帖子评分 6 分/ });
		fireEvent.focus(first);
		expect(screen.getByText("高信息价值")).toBeInTheDocument();
		fireEvent.pointerEnter(second.parentElement as HTMLElement);
		expect(screen.queryByText("高信息价值")).not.toBeInTheDocument();
		expect(screen.getByText("中等信息价值")).toBeInTheDocument();
	});

	it("does not bubble score clicks into the timeline card", () => {
		let clicks = 0;
		render(
			<div onClick={() => (clicks += 1)}>
				<TweetScoreBadge score={score} />
			</div>,
		);
		fireEvent.click(screen.getByRole("button", { name: /帖子评分 8 分/ }));
		expect(clicks).toBe(0);
	});
});
