import { fetchJson } from "./api-client";
import {
	tweetScoresResponseSchema,
	type TweetScoresRequest,
} from "./api-contracts";
import type { TweetQualityScore } from "./types";

type TweetScoreInput = TweetScoresRequest["tweets"][number];

interface PendingScoreRequest {
	batch?: PendingScoreRequest[];
	batchController?: AbortController;
	input: TweetScoreInput;
	onAbort: () => void;
	resolve: (score: TweetQualityScore) => void;
	reject: (error: unknown) => void;
	settled: boolean;
	signal?: AbortSignal;
}

const pendingRequests: PendingScoreRequest[] = [];
const inFlightRequests = new Map<string, Promise<TweetQualityScore>>();
const TIMELINE_SCORE_BATCH_SIZE = 12;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let flushActive = false;

function abortError() {
	if (typeof DOMException !== "undefined") {
		return new DOMException("The score request was cancelled", "AbortError");
	}
	const error = new Error("The score request was cancelled");
	error.name = "AbortError";
	return error;
}

function finishRequest(
	request: PendingScoreRequest,
	result:
		| { ok: true; score: TweetQualityScore }
		| { ok: false; error: unknown },
) {
	if (request.settled) return;
	request.settled = true;
	request.signal?.removeEventListener("abort", request.onAbort);
	if (result.ok) request.resolve(result.score);
	else request.reject(result.error);
}

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
	if (flushActive) return;
	flushActive = true;
	flushTimer = undefined;
	try {
		const batch = pendingRequests
			.splice(0, TIMELINE_SCORE_BATCH_SIZE)
			.filter((request) => !request.settled && !request.signal?.aborted);
		if (batch.length === 0) return;
		const controller = new AbortController();
		for (const request of batch) {
			request.batch = batch;
			request.batchController = controller;
		}
		try {
			const scores = await fetchTweetScores(
				batch.map((request) => request.input),
				controller.signal,
			);
			const byId = new Map(scores.map((score) => [score.tweetId, score]));
			for (const request of batch) {
				const score = byId.get(request.input.tweetId);
				if (score) finishRequest(request, { ok: true, score });
				else {
					finishRequest(request, {
						ok: false,
						error: new Error("评分结果缺失"),
					});
				}
			}
		} catch (error) {
			for (const request of batch) {
				finishRequest(request, { ok: false, error });
			}
		} finally {
			for (const request of batch) {
				request.batch = undefined;
				request.batchController = undefined;
			}
		}
	} finally {
		flushActive = false;
		if (pendingRequests.length > 0 && !flushTimer) {
			flushTimer = setTimeout(() => void flushScoreRequests(), 24);
		}
	}
}

export function requestTweetScore(
	input: TweetScoreInput,
	signal?: AbortSignal,
) {
	if (signal?.aborted) return Promise.reject(abortError());
	const key = scoreRequestKey(input);
	const existing = inFlightRequests.get(key);
	if (existing) return existing;
	const request = new Promise<TweetQualityScore>((resolve, reject) => {
		const pending: PendingScoreRequest = {
			input,
			onAbort: () => {
				const index = pendingRequests.indexOf(pending);
				if (index >= 0) pendingRequests.splice(index, 1);
				finishRequest(pending, { ok: false, error: abortError() });
				if (pending.batch && pending.batch.every((entry) => entry.settled)) {
					pending.batchController?.abort();
				}
			},
			resolve,
			reject,
			settled: false,
			signal,
		};
		signal?.addEventListener("abort", pending.onAbort, { once: true });
		pendingRequests.push(pending);
		if (!flushTimer && !flushActive) {
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
	flushActive = false;
	for (const request of pendingRequests.splice(0)) {
		request.signal?.removeEventListener("abort", request.onAbort);
	}
	inFlightRequests.clear();
}

export const __test__ = {
	flushScoreRequests,
	resetForTests,
	scoreRequestKey,
};
