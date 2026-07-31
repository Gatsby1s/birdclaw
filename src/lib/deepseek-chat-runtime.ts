import { Effect } from "effect";
import { tryPromise } from "./effect-runtime";
import {
	defaultRuntimeServices,
	type RuntimeServices,
} from "./runtime-services";

const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEFAULT_DEEPSEEK_MAX_RETRIES = 2;
const DEFAULT_DEEPSEEK_RETRY_BASE_DELAY_MS = 500;
const DEFAULT_DEEPSEEK_RETRY_MAX_DELAY_MS = 5_000;
const MAX_DEEPSEEK_SERVER_RETRY_DELAY_MS = 60_000;

function toError(error: unknown) {
	return error instanceof Error ? error : new Error(String(error));
}

function abortError(signal: AbortSignal) {
	const reason = signal.reason;
	if (reason instanceof Error) return reason;
	return new DOMException("The operation was aborted", "AbortError");
}

function waitForRetryEffect(delayMs: number, signal?: AbortSignal) {
	if (delayMs <= 0) return Effect.void;
	if (!signal) {
		return tryPromise(
			() => new Promise<void>((resolve) => setTimeout(resolve, delayMs)),
		).pipe(Effect.mapError(toError));
	}
	return tryPromise(
		() =>
			new Promise<void>((resolve, reject) => {
				if (signal.aborted) {
					reject(abortError(signal));
					return;
				}
				const onAbort = () => {
					clearTimeout(timer);
					reject(abortError(signal));
				};
				const timer = setTimeout(() => {
					signal.removeEventListener("abort", onAbort);
					resolve();
				}, delayMs);
				signal.addEventListener("abort", onAbort, { once: true });
			}),
	).pipe(Effect.mapError(toError));
}

function retryAfterDelayMs(
	response: Response,
	attempt: number,
	runtime: RuntimeServices,
	baseDelayMs: number,
	maxDelayMs: number,
) {
	const retryAfterMs = Number(response.headers.get("retry-after-ms")?.trim());
	if (
		Number.isFinite(retryAfterMs) &&
		retryAfterMs >= 0 &&
		retryAfterMs <= MAX_DEEPSEEK_SERVER_RETRY_DELAY_MS
	) {
		return Math.round(retryAfterMs);
	}
	const retryAfter = response.headers.get("retry-after")?.trim();
	if (retryAfter) {
		const seconds = Number(retryAfter);
		const secondsDelayMs = seconds * 1_000;
		if (
			Number.isFinite(secondsDelayMs) &&
			secondsDelayMs >= 0 &&
			secondsDelayMs <= MAX_DEEPSEEK_SERVER_RETRY_DELAY_MS
		) {
			return Math.round(secondsDelayMs);
		}
		const date = Date.parse(retryAfter);
		if (Number.isFinite(date)) {
			const dateDelayMs = Math.max(0, date - runtime.now().getTime());
			if (dateDelayMs <= MAX_DEEPSEEK_SERVER_RETRY_DELAY_MS) {
				return dateDelayMs;
			}
		}
	}
	const exponentialDelay = baseDelayMs * 2 ** attempt;
	const jitter = baseDelayMs * 0.25 * runtime.random();
	return Math.min(Math.round(exponentialDelay + jitter), maxDelayMs);
}

function shouldRetryDeepSeekResponse(response: Response) {
	const directive = response.headers
		.get("x-should-retry")
		?.trim()
		.toLowerCase();
	if (directive === "false") return false;
	if (directive === "true") return true;
	return (
		response.status === 408 ||
		response.status === 409 ||
		response.status === 429 ||
		response.status >= 500
	);
}

export function redactDeepSeekError(text: string) {
	return text.replace(/\bsk-[A-Za-z0-9_-]+\b/g, (key) => {
		if (key.length <= 12) return "sk-...";
		return `${key.slice(0, 7)}...${key.slice(-4)}`;
	});
}

function deepSeekErrorDetail(text: string) {
	let detail = text.trim();
	try {
		const payload = JSON.parse(detail) as {
			error?: { message?: unknown };
		};
		if (typeof payload.error?.message === "string") {
			detail = payload.error.message.trim();
		}
	} catch {
		// OpenAI-compatible endpoints may return plain text.
	}
	return redactDeepSeekError(detail).slice(0, 400);
}

export function resolveDeepSeekUrl(baseUrl?: string) {
	const base = (baseUrl || DEFAULT_DEEPSEEK_BASE_URL).replace(/\/+$/, "");
	return `${base}/chat/completions`;
}

export function extractDeepSeekChatCompletionText(payload: unknown) {
	if (!payload || typeof payload !== "object") return "";
	const choices = (payload as { choices?: unknown }).choices;
	if (!Array.isArray(choices)) return "";
	const first = choices[0];
	if (!first || typeof first !== "object") return "";
	const message = (first as { message?: unknown }).message;
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	return typeof content === "string" ? content : "";
}

export function requestDeepSeekChatCompletionEffect({
	body,
	signal,
	runtime = defaultRuntimeServices,
	maxRetries = DEFAULT_DEEPSEEK_MAX_RETRIES,
	retryBaseDelayMs = DEFAULT_DEEPSEEK_RETRY_BASE_DELAY_MS,
	retryMaxDelayMs = DEFAULT_DEEPSEEK_RETRY_MAX_DELAY_MS,
}: {
	body: unknown;
	signal?: AbortSignal;
	runtime?: RuntimeServices;
	maxRetries?: number;
	retryBaseDelayMs?: number;
	retryMaxDelayMs?: number;
}): Effect.Effect<Response, Error> {
	return Effect.gen(function* () {
		const apiKey = runtime.env("DEEPSEEK_API_KEY");
		if (!apiKey) {
			return yield* Effect.fail(new Error("DEEPSEEK_API_KEY is not set"));
		}
		const url = resolveDeepSeekUrl(runtime.env("DEEPSEEK_BASE_URL"));
		const retryCount = Math.max(0, Math.floor(maxRetries));
		for (let attempt = 0; ; attempt += 1) {
			const response = yield* tryPromise(() =>
				runtime.fetch(url, {
					method: "POST",
					signal,
					headers: {
						authorization: `Bearer ${apiKey}`,
						"content-type": "application/json",
					},
					body: JSON.stringify(body),
				}),
			).pipe(Effect.mapError(toError));
			if (response.ok) return response;

			const canRetry =
				attempt < retryCount && shouldRetryDeepSeekResponse(response);
			if (canRetry) {
				const delayMs = retryAfterDelayMs(
					response,
					attempt,
					runtime,
					Math.max(0, retryBaseDelayMs),
					Math.max(0, retryMaxDelayMs),
				);
				yield* tryPromise(
					() => response.body?.cancel() ?? Promise.resolve(),
				).pipe(Effect.catchAll(() => Effect.void));
				yield* waitForRetryEffect(delayMs, signal);
				continue;
			}

			const text = yield* tryPromise(() => response.text()).pipe(
				Effect.mapError(toError),
			);
			const attempts = attempt + 1;
			const suffix =
				attempts > 1 ? ` (after ${String(attempts)} attempts)` : "";
			return yield* Effect.fail(
				new Error(
					`DeepSeek request failed: ${String(response.status)} ${deepSeekErrorDetail(text)}${suffix}`,
				),
			);
		}
	});
}
