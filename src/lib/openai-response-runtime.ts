import { Effect } from "effect";
import { tryPromise } from "./effect-runtime";
import {
	defaultRuntimeServices,
	type RuntimeServices,
} from "./runtime-services";

const DEFAULT_DELIMITER_PATTERN = /\n---\s*\n/;
const DEFAULT_DELIMITER_HOLD = 8;
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com";
const DEFAULT_OPENAI_MAX_RETRIES = 2;
const DEFAULT_OPENAI_RETRY_BASE_DELAY_MS = 500;
const DEFAULT_OPENAI_RETRY_MAX_DELAY_MS = 5_000;
const MAX_OPENAI_SERVER_RETRY_DELAY_MS = 60_000;

export interface OpenAIStreamState {
	eventBuffer: string;
	rawText: string;
	pendingVisible: string;
	jsonMode: boolean;
	responseId?: string;
	usage?: unknown;
	error?: string;
}

export interface OpenAIStreamResult {
	rawText: string;
	responseId?: string;
	usage?: unknown;
}

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
		retryAfterMs <= MAX_OPENAI_SERVER_RETRY_DELAY_MS
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
			secondsDelayMs <= MAX_OPENAI_SERVER_RETRY_DELAY_MS
		) {
			return Math.round(secondsDelayMs);
		}
		const date = Date.parse(retryAfter);
		if (Number.isFinite(date)) {
			const dateDelayMs = Math.max(0, date - runtime.now().getTime());
			if (dateDelayMs <= MAX_OPENAI_SERVER_RETRY_DELAY_MS) {
				return dateDelayMs;
			}
		}
	}
	const exponentialDelay = baseDelayMs * 2 ** attempt;
	const jitter = baseDelayMs * 0.25 * runtime.random();
	return Math.min(Math.round(exponentialDelay + jitter), maxDelayMs);
}

function shouldRetryOpenAIResponse(response: Response) {
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

function openAIErrorDetail(text: string) {
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
	return redactOpenAIError(detail).slice(0, 400);
}

export function resolveOpenAIUrl(path: string, baseUrl?: string) {
	const base = (baseUrl || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");
	if (base.endsWith("/v1") && path.startsWith("/v1/")) {
		return `${base}${path.slice(3)}`;
	}
	return `${base}${path}`;
}

export function redactOpenAIError(text: string) {
	return text.replace(/\bsk-[A-Za-z0-9_-]+\b/g, (key) => {
		if (key.length <= 12) return "sk-...";
		return `${key.slice(0, 7)}...${key.slice(-4)}`;
	});
}

export function createOpenAIStreamState(): OpenAIStreamState {
	return {
		eventBuffer: "",
		rawText: "",
		pendingVisible: "",
		jsonMode: false,
	};
}

function emitVisibleDelta(
	state: OpenAIStreamState,
	delta: string,
	onDelta: ((delta: string) => void) | undefined,
	delimiterPattern: RegExp,
	delimiterHold: number,
) {
	state.rawText += delta;
	if (state.jsonMode) return;

	const combined = state.pendingVisible + delta;
	const delimiterIndex = combined.search(delimiterPattern);
	if (delimiterIndex >= 0) {
		const visible = combined.slice(0, delimiterIndex);
		if (visible) onDelta?.(visible);
		state.pendingVisible = "";
		state.jsonMode = true;
		return;
	}

	if (combined.length <= delimiterHold) {
		state.pendingVisible = combined;
		return;
	}

	const visible = combined.slice(0, -delimiterHold);
	state.pendingVisible = combined.slice(-delimiterHold);
	if (visible) onDelta?.(visible);
}

function handleOpenAIEvent(
	state: OpenAIStreamState,
	event: Record<string, unknown>,
	onDelta: ((delta: string) => void) | undefined,
	delimiterPattern: RegExp,
	delimiterHold: number,
) {
	const type = typeof event.type === "string" ? event.type : "";
	if (
		type === "response.output_text.delta" &&
		typeof event.delta === "string"
	) {
		emitVisibleDelta(
			state,
			event.delta,
			onDelta,
			delimiterPattern,
			delimiterHold,
		);
		return;
	}
	if (type === "response.completed") {
		const response = event.response;
		if (response && typeof response === "object") {
			const record = response as Record<string, unknown>;
			state.responseId = typeof record.id === "string" ? record.id : undefined;
			state.usage = record.usage;
		}
		return;
	}
	if (type === "response.error" || type === "error") {
		const error = event.error;
		state.error =
			error && typeof error === "object" && "message" in error
				? String((error as { message?: unknown }).message)
				: "OpenAI stream failed";
		return;
	}
	if (type === "response.failed" || type === "response.incomplete") {
		const response = event.response;
		const record =
			response && typeof response === "object"
				? (response as Record<string, unknown>)
				: {};
		const error = record.error;
		const incomplete = record.incomplete_details;
		state.error =
			error && typeof error === "object" && "message" in error
				? String((error as { message?: unknown }).message)
				: incomplete && typeof incomplete === "object" && "reason" in incomplete
					? `OpenAI response incomplete: ${String((incomplete as { reason?: unknown }).reason)}`
					: "OpenAI stream failed";
	}
}

export function processOpenAIResponseSseChunk(
	state: OpenAIStreamState,
	chunk: string,
	{
		onDelta,
		delimiterPattern = DEFAULT_DELIMITER_PATTERN,
		delimiterHold = DEFAULT_DELIMITER_HOLD,
	}: {
		onDelta?: (delta: string) => void;
		delimiterPattern?: RegExp;
		delimiterHold?: number;
	} = {},
) {
	state.eventBuffer += chunk;
	let boundary = state.eventBuffer.indexOf("\n\n");
	while (boundary >= 0) {
		const block = state.eventBuffer.slice(0, boundary);
		state.eventBuffer = state.eventBuffer.slice(boundary + 2);
		const data = block
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n");
		if (data && data !== "[DONE]") {
			try {
				handleOpenAIEvent(
					state,
					JSON.parse(data) as Record<string, unknown>,
					onDelta,
					delimiterPattern,
					delimiterHold,
				);
			} catch {
				// The feature parser decides whether partial output remains usable.
			}
		}
		boundary = state.eventBuffer.indexOf("\n\n");
	}
}

export function readOpenAIResponseStreamEffect(
	response: Response,
	options: {
		onDelta?: (delta: string) => void;
		delimiterPattern?: RegExp;
		delimiterHold?: number;
	} = {},
): Effect.Effect<OpenAIStreamResult, Error> {
	const reader = response.body?.getReader();
	if (!reader) {
		return Effect.fail(new Error("OpenAI response did not include a stream"));
	}
	const decoder = new TextDecoder();

	return Effect.gen(function* () {
		const state = createOpenAIStreamState();
		for (;;) {
			const { done, value } = yield* tryPromise(() => reader.read()).pipe(
				Effect.mapError(toError),
			);
			if (!done) {
				processOpenAIResponseSseChunk(
					state,
					decoder.decode(value, { stream: true }),
					options,
				);
				continue;
			}
			if (!state.jsonMode && state.pendingVisible) {
				options.onDelta?.(state.pendingVisible);
			}
			if (state.error) {
				return yield* Effect.fail(new Error(state.error));
			}
			return {
				rawText: state.rawText,
				...(state.responseId ? { responseId: state.responseId } : {}),
				...(state.usage === undefined ? {} : { usage: state.usage }),
			};
		}
	}).pipe(
		Effect.ensuring(
			Effect.sync(() => {
				reader.releaseLock();
			}),
		),
	);
}

export function requestOpenAIResponseEffect({
	body,
	signal,
	runtime = defaultRuntimeServices,
	maxRetries = DEFAULT_OPENAI_MAX_RETRIES,
	retryBaseDelayMs = DEFAULT_OPENAI_RETRY_BASE_DELAY_MS,
	retryMaxDelayMs = DEFAULT_OPENAI_RETRY_MAX_DELAY_MS,
}: {
	body: unknown;
	signal?: AbortSignal;
	runtime?: RuntimeServices;
	maxRetries?: number;
	retryBaseDelayMs?: number;
	retryMaxDelayMs?: number;
}): Effect.Effect<Response, Error> {
	return Effect.gen(function* () {
		const apiKey = runtime.env("OPENAI_API_KEY");
		if (!apiKey) {
			return yield* Effect.fail(new Error("OPENAI_API_KEY is not set"));
		}
		const url = resolveOpenAIUrl(
			"/v1/responses",
			runtime.env("OPENAI_BASE_URL"),
		);
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
				attempt < retryCount && shouldRetryOpenAIResponse(response);
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
					`OpenAI request failed: ${String(response.status)} ${openAIErrorDetail(text)}${suffix}`,
				),
			);
		}
	});
}
