import { randomUUID } from "node:crypto";
import { z } from "zod";
import { runEffectPromise } from "./effect-runtime";
import { redactProviderError } from "./openai-response-runtime";
import {
	streamSummaryAnalysisEffect,
	type SummaryAnalysisBody,
} from "./summary-model-runtime";

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_LONG_POLL_MS = 20_000;
const GET_REQUEST_TIMEOUT_MS = 30_000;
const POST_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_CLAIM_TIMEOUT_MS = 8_000;
const DEFAULT_LEASE_MS = 20_000;
const SIGNAL_WAIT_MS = 500;
const TERMINAL_TTL_MS = 5 * 60_000;
const MAX_VISIBLE_DELTA_CHARS = 256_000;
const MAX_RAW_OUTPUT_CHARS = 8_000_000;

const localAnalysisBodySchema = z
	.object({
		input: z
			.array(
				z.object({
					role: z.enum(["system", "user"]),
					content: z.string().max(1_500_000),
				}),
			)
			.min(1)
			.max(8),
		max_output_tokens: z.number().int().positive().max(20_000).optional(),
		stream: z.boolean().optional(),
	})
	.passthrough();

export const localAnalysisJobPayloadSchema = z.object({
	kind: z.literal("profile-analysis"),
	body: localAnalysisBodySchema,
});

export type LocalAnalysisJobPayload = z.infer<
	typeof localAnalysisJobPayloadSchema
>;

const localAnalysisClaimSchema = z.object({
	id: z.string().uuid(),
	leaseToken: z.string().uuid(),
	payload: localAnalysisJobPayloadSchema,
});

export type LocalAnalysisClaim = z.infer<typeof localAnalysisClaimSchema>;

const submissionBaseSchema = z.object({
	jobId: z.string().uuid(),
	leaseToken: z.string().uuid(),
	sequence: z.number().int().positive(),
});

export const localAnalysisSubmissionSchema = z.discriminatedUnion("type", [
	submissionBaseSchema.extend({ type: z.literal("heartbeat") }),
	submissionBaseSchema.extend({
		type: z.literal("delta"),
		delta: z.string().min(1).max(MAX_VISIBLE_DELTA_CHARS),
	}),
	submissionBaseSchema.extend({
		type: z.literal("done"),
		rawText: z.string().min(1).max(MAX_RAW_OUTPUT_CHARS),
		model: z.string().min(1).max(256),
	}),
	submissionBaseSchema.extend({
		type: z.literal("error"),
		error: z.string().min(1).max(10_000),
	}),
]);

export type LocalAnalysisSubmission = z.infer<
	typeof localAnalysisSubmissionSchema
>;

type LocalAnalysisJobStatus =
	| "pending"
	| "claimed"
	| "done"
	| "failed"
	| "cancelled";

interface LocalAnalysisJob {
	id: string;
	payload: LocalAnalysisJobPayload;
	status: LocalAnalysisJobStatus;
	createdAtMs: number;
	updatedAtMs: number;
	expiresAtMs: number;
	leaseToken?: string;
	leaseExpiresAtMs?: number;
	sequence: number;
	events: Array<{ sequence: number; delta: string }>;
	result?: { rawText: string; model: string };
	error?: string;
	waiters: Set<() => void>;
}

interface LocalAnalysisStore {
	jobs: Map<string, LocalAnalysisJob>;
	claimWaiters: Set<() => void>;
}

const STORE_KEY = Symbol.for("birdclaw.local-analysis-bridge.store");
const storeGlobal = globalThis as typeof globalThis & Record<symbol, unknown>;

function getStore() {
	let store = storeGlobal[STORE_KEY] as LocalAnalysisStore | undefined;
	if (!store) {
		store = { jobs: new Map(), claimWaiters: new Set() };
		storeGlobal[STORE_KEY] = store;
	}
	store.claimWaiters ??= new Set();
	return store;
}

function toError(error: unknown) {
	return error instanceof Error ? error : new Error(String(error));
}

function positiveMilliseconds(value: string | undefined, fallback: number) {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function notify(job: LocalAnalysisJob) {
	for (const waiter of job.waiters) waiter();
	job.waiters.clear();
}

function markFailed(job: LocalAnalysisJob, error: string, nowMs: number) {
	job.status = "failed";
	job.error = error;
	job.updatedAtMs = nowMs;
	notify(job);
}

function reapJobs(nowMs = Date.now()) {
	for (const [id, job] of getStore().jobs) {
		if (job.status === "pending" && job.expiresAtMs <= nowMs) {
			markFailed(job, "Local ChatGPT bridge did not claim the job", nowMs);
		}
		if (
			job.status === "claimed" &&
			job.leaseExpiresAtMs !== undefined &&
			job.leaseExpiresAtMs <= nowMs
		) {
			markFailed(job, "Local ChatGPT bridge lease expired", nowMs);
		}
		if (
			(job.status === "done" ||
				job.status === "failed" ||
				job.status === "cancelled") &&
			nowMs - job.updatedAtMs >= TERMINAL_TTL_MS
		) {
			getStore().jobs.delete(id);
		}
	}
}

export function isLocalAnalysisBrokerConfigured() {
	return Boolean(process.env.BIRDCLAW_LOCAL_BRIDGE_TOKEN?.trim());
}

export function enqueueLocalAnalysisJob(
	payload: LocalAnalysisJobPayload,
	{
		nowMs = Date.now(),
		claimTimeoutMs = positiveMilliseconds(
			process.env.BIRDCLAW_LOCAL_ANALYSIS_CLAIM_TIMEOUT_MS,
			DEFAULT_CLAIM_TIMEOUT_MS,
		),
	}: { nowMs?: number; claimTimeoutMs?: number } = {},
) {
	reapJobs(nowMs);
	const job: LocalAnalysisJob = {
		id: randomUUID(),
		payload: localAnalysisJobPayloadSchema.parse(payload),
		status: "pending",
		createdAtMs: nowMs,
		updatedAtMs: nowMs,
		expiresAtMs: nowMs + claimTimeoutMs,
		sequence: 0,
		events: [],
		waiters: new Set(),
	};
	getStore().jobs.set(job.id, job);
	for (const waiter of getStore().claimWaiters) waiter();
	getStore().claimWaiters.clear();
	return job.id;
}

export function claimLocalAnalysisJob(nowMs = Date.now()) {
	reapJobs(nowMs);
	const job = [...getStore().jobs.values()]
		.filter((candidate) => candidate.status === "pending")
		.sort((left, right) => left.createdAtMs - right.createdAtMs)[0];
	if (!job) return null;
	job.status = "claimed";
	job.leaseToken = randomUUID();
	job.leaseExpiresAtMs = nowMs + DEFAULT_LEASE_MS;
	job.updatedAtMs = nowMs;
	notify(job);
	return localAnalysisClaimSchema.parse({
		id: job.id,
		leaseToken: job.leaseToken,
		payload: job.payload,
	});
}

export function waitForLocalAnalysisClaim({
	timeoutMs = DEFAULT_LONG_POLL_MS,
	signal,
}: { timeoutMs?: number; signal?: AbortSignal } = {}) {
	if (signal?.aborted) return Promise.resolve(null);
	const immediate = claimLocalAnalysisJob();
	if (immediate) return Promise.resolve(immediate);
	return new Promise<LocalAnalysisClaim | null>((resolve) => {
		const store = getStore();
		let settled = false;
		const finish = (shouldClaim: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			store.claimWaiters.delete(wake);
			signal?.removeEventListener("abort", abort);
			resolve(shouldClaim ? claimLocalAnalysisJob() : null);
		};
		const wake = () => finish(true);
		const abort = () => finish(false);
		const timeout = setTimeout(wake, Math.max(1, timeoutMs));
		store.claimWaiters.add(wake);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) {
			abort();
			return;
		}
		const raced = claimLocalAnalysisJob();
		if (raced) {
			settled = true;
			clearTimeout(timeout);
			store.claimWaiters.delete(wake);
			signal?.removeEventListener("abort", abort);
			resolve(raced);
		}
	});
}

export function submitLocalAnalysisEvent(
	input: LocalAnalysisSubmission,
	nowMs = Date.now(),
) {
	const submission = localAnalysisSubmissionSchema.parse(input);
	reapJobs(nowMs);
	const job = getStore().jobs.get(submission.jobId);
	if (!job) throw new Error("Local analysis job was not found");
	if (job.status !== "claimed") {
		throw new Error(`Local analysis job is ${job.status}`);
	}
	if (job.leaseToken !== submission.leaseToken) {
		throw new Error("Local analysis lease token is invalid");
	}
	if (submission.sequence <= job.sequence) {
		return { ok: true as const, sequence: job.sequence, duplicate: true };
	}
	if (submission.sequence !== job.sequence + 1) {
		throw new Error("Local analysis event sequence is out of order");
	}
	job.sequence = submission.sequence;
	job.updatedAtMs = nowMs;
	job.leaseExpiresAtMs = nowMs + DEFAULT_LEASE_MS;
	if (submission.type === "delta") {
		job.events.push({ sequence: submission.sequence, delta: submission.delta });
	}
	if (submission.type === "done") {
		job.status = "done";
		job.result = { rawText: submission.rawText, model: submission.model };
	}
	if (submission.type === "error") {
		markFailed(job, submission.error, nowMs);
		return { ok: true as const, sequence: job.sequence, duplicate: false };
	}
	notify(job);
	return { ok: true as const, sequence: job.sequence, duplicate: false };
}

function cancelLocalAnalysisJob(id: string, nowMs = Date.now()) {
	const job = getStore().jobs.get(id);
	if (!job || job.status === "done" || job.status === "failed") return;
	job.status = "cancelled";
	job.updatedAtMs = nowMs;
	notify(job);
}

function snapshotLocalAnalysisJob(id: string, afterSequence: number) {
	reapJobs();
	const job = getStore().jobs.get(id);
	if (!job) return null;
	return {
		status: job.status,
		sequence: job.sequence,
		events: job.events.filter((event) => event.sequence > afterSequence),
		result: job.result,
		error: job.error,
		leaseExpiresAtMs: job.leaseExpiresAtMs,
	};
}

function waitForJobSignal(id: string, signal?: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		const job = getStore().jobs.get(id);
		if (!job) {
			resolve();
			return;
		}
		const activeJob = job;
		let settled = false;
		let timeout: ReturnType<typeof setTimeout>;
		function finish(error?: Error) {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			activeJob.waiters.delete(wake);
			signal?.removeEventListener("abort", abort);
			if (error) reject(error);
			else resolve();
		}
		function wake() {
			finish();
		}
		function abort() {
			finish(new DOMException("aborted", "AbortError"));
		}
		timeout = setTimeout(wake, SIGNAL_WAIT_MS);
		activeJob.waiters.add(wake);
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
	});
}

export async function streamLocalAnalysisJob(
	payload: LocalAnalysisJobPayload,
	{
		signal,
		onClaimed,
		onDelta,
		claimTimeoutMs = positiveMilliseconds(
			process.env.BIRDCLAW_LOCAL_ANALYSIS_CLAIM_TIMEOUT_MS,
			DEFAULT_CLAIM_TIMEOUT_MS,
		),
	}: {
		signal?: AbortSignal;
		onClaimed?: () => void;
		onDelta?: (delta: string) => void;
		claimTimeoutMs?: number;
	} = {},
) {
	const id = enqueueLocalAnalysisJob(payload, { claimTimeoutMs });
	const claimDeadlineMs = Date.now() + claimTimeoutMs;
	let sequence = 0;
	let emitted = false;
	let claimed = false;
	try {
		for (;;) {
			if (signal?.aborted) throw new DOMException("aborted", "AbortError");
			const snapshot = snapshotLocalAnalysisJob(id, sequence);
			if (!snapshot) {
				if (emitted) throw new Error("Local ChatGPT bridge lost the job");
				return null;
			}
			if (snapshot.status === "claimed" && !claimed) {
				claimed = true;
				onClaimed?.();
			}
			for (const event of snapshot.events) {
				sequence = Math.max(sequence, event.sequence);
				emitted = true;
				onDelta?.(event.delta);
			}
			sequence = Math.max(sequence, snapshot.sequence);
			if (snapshot.status === "done" && snapshot.result) {
				return snapshot.result;
			}
			if (snapshot.status === "failed" || snapshot.status === "cancelled") {
				if (emitted) {
					throw new Error(
						snapshot.error ??
							"Local ChatGPT bridge stopped after streaming began",
					);
				}
				return null;
			}
			if (snapshot.status === "pending" && Date.now() >= claimDeadlineMs) {
				cancelLocalAnalysisJob(id);
				return null;
			}
			await waitForJobSignal(id, signal);
		}
	} catch (error) {
		cancelLocalAnalysisJob(id);
		throw error;
	}
}

function validatedLocalAnalysisUrl(value: string) {
	const url = new URL(value);
	const loopback =
		url.hostname === "localhost" ||
		url.hostname === "127.0.0.1" ||
		url.hostname === "::1";
	if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
		throw new Error("BirdClaw cloud analysis bridge URL must use HTTPS");
	}
	url.pathname = "/api/integrations/local-analysis";
	url.search = "";
	url.hash = "";
	return url.toString();
}

interface LocalAnalysisBridgeWorkerOptions {
	url: string;
	token: string;
	pollIntervalMs?: number;
	fetchImpl?: typeof fetch;
}

export interface LocalAnalysisBridgeWorkerStatus {
	enabled: boolean;
	running: boolean;
	lastSuccessAt: string | null;
	lastError: string | null;
	completedJobs: number;
}

export class LocalAnalysisBridgeWorker {
	private timer: ReturnType<typeof setInterval> | null = null;
	private requestControllers = new Set<AbortController>();
	private executionControllers = new Set<AbortController>();
	private stopped = false;
	private running = false;
	private readonly url: string;
	private readonly pollIntervalMs: number;
	private readonly fetchImpl: typeof fetch;
	private status: LocalAnalysisBridgeWorkerStatus = {
		enabled: true,
		running: false,
		lastSuccessAt: null,
		lastError: null,
		completedJobs: 0,
	};

	constructor(private readonly options: LocalAnalysisBridgeWorkerOptions) {
		if (!options.token.trim()) {
			throw new Error("BirdClaw cloud analysis bridge token is missing");
		}
		this.url = validatedLocalAnalysisUrl(options.url);
		this.pollIntervalMs = Math.max(
			250,
			options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
		);
		this.fetchImpl = options.fetchImpl ?? fetch;
	}

	start() {
		if (this.stopped || this.timer) return;
		void this.runOnce();
		this.timer = setInterval(() => void this.runOnce(), this.pollIntervalMs);
	}

	stop() {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		for (const controller of this.requestControllers) controller.abort();
		this.requestControllers.clear();
		for (const controller of this.executionControllers) controller.abort();
		this.executionControllers.clear();
	}

	getStatus() {
		return { ...this.status };
	}

	private async request(
		method: "GET" | "POST",
		body?: LocalAnalysisSubmission,
	) {
		if (this.stopped) throw new DOMException("aborted", "AbortError");
		const controller = new AbortController();
		this.requestControllers.add(controller);
		const timeout = setTimeout(
			() => controller.abort(),
			method === "GET" ? GET_REQUEST_TIMEOUT_MS : POST_REQUEST_TIMEOUT_MS,
		);
		try {
			const response = await this.fetchImpl(this.url, {
				method,
				signal: controller.signal,
				headers: {
					authorization: `Bearer ${this.options.token}`,
					...(body ? { "content-type": "application/json" } : {}),
				},
				...(body ? { body: JSON.stringify(body) } : {}),
			});
			const payload = (await response.json().catch(() => null)) as Record<
				string,
				unknown
			> | null;
			if (!response.ok || payload?.ok !== true) {
				throw new Error(
					typeof payload?.message === "string"
						? payload.message
						: `BirdClaw cloud analysis bridge failed (${String(response.status)})`,
				);
			}
			return payload;
		} finally {
			clearTimeout(timeout);
			this.requestControllers.delete(controller);
		}
	}

	private async execute(job: LocalAnalysisClaim) {
		let sequence = 0;
		let pendingDelta = "";
		let sendFailure: Error | undefined;
		let sendTail = Promise.resolve();
		const controller = new AbortController();
		this.executionControllers.add(controller);
		const queueSubmission = (
			event:
				| { type: "heartbeat" }
				| { type: "delta"; delta: string }
				| { type: "done"; rawText: string; model: string }
				| { type: "error"; error: string },
		) => {
			if (this.stopped) {
				return Promise.reject(new DOMException("aborted", "AbortError"));
			}
			sequence += 1;
			const submission = localAnalysisSubmissionSchema.parse({
				...event,
				jobId: job.id,
				leaseToken: job.leaseToken,
				sequence,
			});
			const queued = sendTail.then(() =>
				this.request("POST", submission).then(() => undefined),
			);
			sendTail = queued.catch((error) => {
				sendFailure = toError(error);
				controller.abort();
			});
			return queued;
		};
		const flushDelta = () => {
			if (!pendingDelta) return Promise.resolve();
			const delta = pendingDelta;
			pendingDelta = "";
			return queueSubmission({ type: "delta", delta });
		};

		let flushTimer: ReturnType<typeof setInterval> | null = null;
		let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
		try {
			await queueSubmission({ type: "heartbeat" });
			flushTimer = setInterval(
				() => void flushDelta().catch(() => undefined),
				750,
			);
			heartbeatTimer = setInterval(
				() =>
					void queueSubmission({ type: "heartbeat" }).catch(() => undefined),
				5_000,
			);
			const result = await runEffectPromise(
				streamSummaryAnalysisEffect({
					body: job.payload.body as SummaryAnalysisBody,
					options: {},
					provider: "openai",
					allowFailover: false,
					signal: controller.signal,
					parse: (value) => value,
					fallback: () => null,
					onDelta: (delta) => {
						pendingDelta += delta;
						if (pendingDelta.length >= 16_384) {
							void flushDelta().catch(() => undefined);
						}
					},
				}),
			);
			if (heartbeatTimer) clearInterval(heartbeatTimer);
			await flushDelta();
			await sendTail;
			if (sendFailure) throw sendFailure;
			await queueSubmission({
				type: "done",
				rawText: result.rawText,
				model: result.model ?? "gpt",
			});
			await sendTail;
		} catch (error) {
			if (heartbeatTimer) clearInterval(heartbeatTimer);
			if (!this.stopped) await flushDelta().catch(() => undefined);
			await sendTail;
			if (!this.stopped && !sendFailure) {
				await queueSubmission({
					type: "error",
					error: redactProviderError(toError(error).message),
				}).catch(() => undefined);
			}
			throw error;
		} finally {
			if (flushTimer) clearInterval(flushTimer);
			if (heartbeatTimer) clearInterval(heartbeatTimer);
			this.executionControllers.delete(controller);
		}
	}

	async runOnce() {
		if (this.stopped || this.running) return this.getStatus();
		this.running = true;
		this.status = { ...this.status, running: true };
		try {
			const payload = await this.request("GET");
			const job = payload.job
				? localAnalysisClaimSchema.parse(payload.job)
				: null;
			if (job) {
				await this.execute(job);
				this.status = {
					...this.status,
					lastSuccessAt: new Date().toISOString(),
					lastError: null,
					completedJobs: this.status.completedJobs + 1,
				};
			}
		} catch (error) {
			this.status = { ...this.status, lastError: toError(error).message };
		} finally {
			this.running = false;
			this.status = { ...this.status, running: false };
		}
		return this.getStatus();
	}
}

let activeWorker: LocalAnalysisBridgeWorker | null = null;

export function getLocalAnalysisBridgeWorkerStatus() {
	return (
		activeWorker?.getStatus() ?? {
			enabled: false,
			running: false,
			lastSuccessAt: null,
			lastError: null,
			completedJobs: 0,
		}
	);
}

export function startLocalAnalysisBridgeWorker() {
	const url = process.env.BIRDCLAW_CLOUD_BRIDGE_URL?.trim();
	const token = process.env.BIRDCLAW_CLOUD_BRIDGE_TOKEN?.trim();
	if (!url || !token) return null;
	if (activeWorker) return activeWorker;
	activeWorker = new LocalAnalysisBridgeWorker({
		url,
		token,
		pollIntervalMs: positiveMilliseconds(
			process.env.BIRDCLAW_LOCAL_ANALYSIS_POLL_MS,
			DEFAULT_POLL_INTERVAL_MS,
		),
	});
	activeWorker.start();
	return activeWorker;
}

export function stopLocalAnalysisBridgeWorker() {
	activeWorker?.stop();
	activeWorker = null;
}

export const __test__ = {
	resetStore() {
		getStore().jobs.clear();
		getStore().claimWaiters.clear();
	},
	listJobs() {
		return [...getStore().jobs.values()].map((job) => ({
			id: job.id,
			status: job.status,
			sequence: job.sequence,
		}));
	},
};
