import { fetchJson } from "./api-client";
import {
	tweetScoresResponseSchema,
	type TweetScoresRequest,
} from "./api-contracts";
import type { TweetQualityScore } from "./types";

type TweetScoreInput = TweetScoresRequest["tweets"][number];

interface PendingScoreRequest {
	input: TweetScoreInput;
	resolve: (score: TweetQualityScore) => void;
	reject: (error: unknown) => void;
}

const pendingRequests: PendingScoreRequest[] = [];
const inFlightRequests = new Map<string, Promise<TweetQualityScore>>();
const TIMELINE_SCORE_BATCH_SIZE = 12;
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function scoreRequestKey(input: TweetScoreInput) {
	return JSON.stringify({
		tweetId: input.tweetId,
		text: input.text,
		createdAt: input.createdAt ?? "",
		author: input.author
			? {
					handle: input.author.handle,
					displayName: input.author.displayName,
					bio: input.author.bio ?? "",
				}
			: null,
	});
}

export async function fetchTweetScores(
	inputs: TweetScoreInput[],
	signal?: AbortSignal,
) {
	const uniqueInputs = [
		...new Map(inputs.map((input) => [input.tweetId, input])).values(),
	];
	const scores: TweetQualityScore[] = [];
	for (let index = 0; index < uniqueInputs.length; index += 50) {
		const response = await fetchJson(
			"/api/tweet-scores",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ tweets: uniqueInputs.slice(index, index + 50) }),
				signal,
			},
			tweetScoresResponseSchema,
			"评分暂时不可用",
		);
		scores.push(...response.scores);
	}
	const scoreById = new Map(scores.map((score) => [score.tweetId, score]));
	return uniqueInputs.map((input) => {
		const score = scoreById.get(input.tweetId);
		if (!score) throw new Error(`评分结果缺失：${input.tweetId}`);
		return score;
	});
}

async function flushScoreRequests() {
	flushTimer = undefined;
	const batch = pendingRequests.splice(0, TIMELINE_SCORE_BATCH_SIZE);
	if (batch.length === 0) return;
	try {
		const scores = await fetchTweetScores(
			batch.map((request) => request.input),
		);
		const byId = new Map(scores.map((score) => [score.tweetId, score]));
		for (const request of batch) {
			const score = byId.get(request.input.tweetId);
			if (score) request.resolve(score);
			else request.reject(new Error("评分结果缺失"));
		}
	} catch (error) {
		for (const request of batch) request.reject(error);
	}
	if (pendingRequests.length > 0 && !flushTimer) {
		flushTimer = setTimeout(() => void flushScoreRequests(), 24);
	}
}

export function requestTweetScore(input: TweetScoreInput) {
	const key = scoreRequestKey(input);
	const existing = inFlightRequests.get(key);
	if (existing) return existing;
	const request = new Promise<TweetQualityScore>((resolve, reject) => {
		pendingRequests.push({ input, resolve, reject });
		if (!flushTimer) {
			flushTimer = setTimeout(() => void flushScoreRequests(), 24);
		}
	});
	inFlightRequests.set(key, request);
	void request.then(
		() => {
			if (inFlightRequests.get(key) === request) inFlightRequests.delete(key);
		},
		() => {
			if (inFlightRequests.get(key) === request) inFlightRequests.delete(key);
		},
	);
	return request;
}

function resetForTests() {
	if (flushTimer) clearTimeout(flushTimer);
	flushTimer = undefined;
	pendingRequests.splice(0);
	inFlightRequests.clear();
}

export const __test__ = {
	flushScoreRequests,
	resetForTests,
	scoreRequestKey,
};
