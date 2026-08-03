// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	__test__,
	claimLocalAnalysisJob,
	enqueueLocalAnalysisJob,
	LocalAnalysisBridgeWorker,
	streamLocalAnalysisJob,
	submitLocalAnalysisEvent,
	waitForLocalAnalysisClaim,
} from "./local-analysis-bridge";

const payload = {
	kind: "profile-analysis" as const,
	body: {
		input: [
			{ role: "system" as const, content: "Analyze precisely." },
			{ role: "user" as const, content: "Local profile context." },
		],
		max_output_tokens: 500,
		stream: true,
	},
};

afterEach(() => {
	__test__.resetStore();
	delete process.env.OPENAI_API_KEY;
	vi.unstubAllGlobals();
});

describe("local analysis bridge", () => {
	it("streams an authenticated worker result back to the waiting cloud request", async () => {
		const deltas: string[] = [];
		const resultPromise = streamLocalAnalysisJob(payload, {
			claimTimeoutMs: 500,
			onDelta: (delta) => deltas.push(delta),
		});
		const claim = claimLocalAnalysisJob();
		expect(claim).not.toBeNull();
		if (!claim) throw new Error("expected claim");
		submitLocalAnalysisEvent({
			type: "heartbeat",
			jobId: claim.id,
			leaseToken: claim.leaseToken,
			sequence: 1,
		});
		submitLocalAnalysisEvent({
			type: "delta",
			jobId: claim.id,
			leaseToken: claim.leaseToken,
			sequence: 2,
			delta: "GPT answer",
		});
		submitLocalAnalysisEvent({
			type: "done",
			jobId: claim.id,
			leaseToken: claim.leaseToken,
			sequence: 3,
			rawText: "GPT answer\n\n---\n{}",
			model: "gpt-5.5",
		});

		await expect(resultPromise).resolves.toEqual({
			rawText: "GPT answer\n\n---\n{}",
			model: "gpt-5.5",
		});
		expect(deltas).toEqual(["GPT answer"]);
	});

	it("returns null when no Mac worker claims the job", async () => {
		await expect(
			streamLocalAnalysisJob(payload, { claimTimeoutMs: 10 }),
		).resolves.toBeNull();
	});

	it("fails instead of mixing DeepSeek after GPT has already streamed", async () => {
		const resultPromise = streamLocalAnalysisJob(payload, {
			claimTimeoutMs: 500,
			onDelta: () => undefined,
		});
		const claim = claimLocalAnalysisJob();
		if (!claim) throw new Error("expected claim");
		submitLocalAnalysisEvent({
			type: "delta",
			jobId: claim.id,
			leaseToken: claim.leaseToken,
			sequence: 1,
			delta: "partial GPT",
		});
		submitLocalAnalysisEvent({
			type: "error",
			jobId: claim.id,
			leaseToken: claim.leaseToken,
			sequence: 2,
			error: "worker interrupted",
		});

		await expect(resultPromise).rejects.toThrow("worker interrupted");
	});

	it("treats repeated events as idempotent and rejects sequence gaps", () => {
		enqueueLocalAnalysisJob(payload, { claimTimeoutMs: 500 });
		const claim = claimLocalAnalysisJob();
		if (!claim) throw new Error("expected claim");
		const heartbeat = {
			type: "heartbeat" as const,
			jobId: claim.id,
			leaseToken: claim.leaseToken,
			sequence: 1,
		};
		expect(submitLocalAnalysisEvent(heartbeat).duplicate).toBe(false);
		expect(submitLocalAnalysisEvent(heartbeat).duplicate).toBe(true);
		expect(() =>
			submitLocalAnalysisEvent({ ...heartbeat, sequence: 3 }),
		).toThrow("out of order");
	});

	it("wakes a long-polling Mac worker as soon as a job is queued", async () => {
		const claimPromise = waitForLocalAnalysisClaim({ timeoutMs: 500 });
		const id = enqueueLocalAnalysisJob(payload, { claimTimeoutMs: 500 });
		await expect(claimPromise).resolves.toMatchObject({ id, payload });
	});

	it("removes a disconnected long-poll waiter without stealing the next job", async () => {
		const controller = new AbortController();
		const abandonedClaim = waitForLocalAnalysisClaim({
			timeoutMs: 500,
			signal: controller.signal,
		});
		controller.abort();
		await expect(abandonedClaim).resolves.toBeNull();

		const id = enqueueLocalAnalysisJob(payload, { claimTimeoutMs: 500 });
		expect(claimLocalAnalysisJob()).toMatchObject({ id });
	});

	it("makes the Mac worker call OpenAI and submit the completed GPT stream", async () => {
		process.env.OPENAI_API_KEY = "openai-test-key";
		const job = {
			id: randomUUID(),
			leaseToken: randomUUID(),
			payload,
		};
		const submissions: Array<Record<string, unknown>> = [];
		const brokerFetch = vi.fn(
			async (_url: string | URL, init?: RequestInit) => {
				if ((init?.method ?? "GET") === "GET") {
					return Response.json({ ok: true, job });
				}
				submissions.push(
					JSON.parse(String(init?.body)) as Record<string, unknown>,
				);
				return Response.json({ ok: true });
			},
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "GPT output" })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1" } })}\n\n`,
						{ headers: { "content-type": "text/event-stream" } },
					),
			),
		);
		const worker = new LocalAnalysisBridgeWorker({
			url: "https://birdclaw.example/api/integrations/local-bridge",
			token: "bridge-test-token",
			fetchImpl: brokerFetch as unknown as typeof fetch,
		});

		await expect(worker.runOnce()).resolves.toMatchObject({ completedJobs: 1 });
		expect(submissions.map((item) => item.type)).toEqual([
			"heartbeat",
			"delta",
			"done",
		]);
		expect(submissions.at(-1)).toMatchObject({
			rawText: "GPT output",
			model: expect.any(String),
		});
		expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
		expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toBe(
			"https://api.openai.com/v1/responses",
		);
	});

	it("aborts an in-flight GPT execution when the local worker stops", async () => {
		process.env.OPENAI_API_KEY = "openai-test-key";
		const job = {
			id: randomUUID(),
			leaseToken: randomUUID(),
			payload,
		};
		const submissions: Array<Record<string, unknown>> = [];
		const brokerFetch = vi.fn(
			async (_url: string | URL, init?: RequestInit) => {
				if ((init?.method ?? "GET") === "GET") {
					return Response.json({ ok: true, job });
				}
				submissions.push(
					JSON.parse(String(init?.body)) as Record<string, unknown>,
				);
				return Response.json({ ok: true });
			},
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(_url: string | URL | Request, init?: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener(
							"abort",
							() => reject(new DOMException("aborted", "AbortError")),
							{ once: true },
						);
					}),
			),
		);
		const worker = new LocalAnalysisBridgeWorker({
			url: "https://birdclaw.example/api/integrations/local-bridge",
			token: "bridge-test-token",
			fetchImpl: brokerFetch as unknown as typeof fetch,
		});

		const run = worker.runOnce();
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
		worker.stop();
		await expect(run).resolves.toMatchObject({
			completedJobs: 0,
			running: false,
		});
		expect(submissions.map((item) => item.type)).toEqual(["heartbeat"]);
	});

	it("can stop a broker request whose headers arrived but JSON body never finishes", async () => {
		const brokerFetch = vi.fn(
			async (_url: string | URL, init?: RequestInit) => {
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							init?.signal?.addEventListener(
								"abort",
								() =>
									controller.error(new DOMException("aborted", "AbortError")),
								{ once: true },
							);
						},
					}),
					{ headers: { "content-type": "application/json" } },
				);
			},
		);
		const worker = new LocalAnalysisBridgeWorker({
			url: "https://birdclaw.example/api/integrations/local-bridge",
			token: "bridge-test-token",
			fetchImpl: brokerFetch as unknown as typeof fetch,
		});

		const run = worker.runOnce();
		await vi.waitFor(() => expect(brokerFetch).toHaveBeenCalledTimes(1));
		worker.stop();
		await expect(run).resolves.toMatchObject({
			completedJobs: 0,
			running: false,
		});
	});
});
