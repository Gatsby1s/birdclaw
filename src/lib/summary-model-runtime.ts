import { Effect } from "effect";
import {
	type AnalysisModelOptions,
	type AnalysisModelSettings,
	type HybridAnalysisResult,
	parseHybridAnalysis,
	readHybridAnalysisStreamEffect,
	resolveAnalysisModelSettings,
} from "./analysis-runtime";
import {
	getDeepSeekApiKey,
	getSummaryModelConfig,
	type SummaryModelProvider,
} from "./config";
import { tryPromise } from "./effect-runtime";
import {
	redactProviderError,
	requestOpenAIResponseEffect,
} from "./openai-response-runtime";
import {
	defaultRuntimeServices,
	type RuntimeServices,
} from "./runtime-services";

const DEFAULT_DELIMITER_PATTERN = /\n---\s*\n/;
const DELIMITER_HOLD = 8;

export interface SummaryModelSettings extends AnalysisModelSettings {
	provider: SummaryModelProvider;
}

interface SummaryModelTarget {
	provider: SummaryModelProvider;
	model: string;
	baseUrl?: string;
	apiKey?: string;
}

interface CanonicalAnalysisBody {
	model?: unknown;
	input?: unknown;
	max_output_tokens?: unknown;
	stream?: unknown;
}

function toError(error: unknown) {
	return error instanceof Error ? error : new Error(String(error));
}

function providerSettings(
	provider: SummaryModelProvider,
	runtime: RuntimeServices,
): SummaryModelTarget {
	const summary = getSummaryModelConfig();
	if (provider === "deepseek") {
		return {
			provider,
			model: runtime.env("DEEPSEEK_MODEL")?.trim() || summary.deepseek.model,
			baseUrl:
				runtime.env("DEEPSEEK_BASE_URL")?.trim() || summary.deepseek.baseUrl,
			apiKey: runtime.env("DEEPSEEK_API_KEY")?.trim() || getDeepSeekApiKey(),
		};
	}
	return {
		provider,
		model:
			configModel(runtime.env("BIRDCLAW_AI_MODEL")) || summary.openai.model,
		baseUrl: runtime.env("OPENAI_BASE_URL")?.trim(),
		apiKey: runtime.env("OPENAI_API_KEY")?.trim(),
	};
}

function configModel(value: string | undefined) {
	return value?.trim() || undefined;
}

function resolveTargets(
	options: AnalysisModelOptions,
	runtime: RuntimeServices,
): SummaryModelTarget[] {
	const configured = getSummaryModelConfig();
	const primary = options.model ? "openai" : configured.primary;
	const providers: SummaryModelProvider[] = [primary];
	if (configured.backup !== primary) providers.push(configured.backup);
	return providers
		.map((provider, index) => {
			const target = providerSettings(provider, runtime);
			return index === 0 && options.model
				? { ...target, model: options.model }
				: target;
		})
		.filter((target, index) => index === 0 || Boolean(target.apiKey));
}

export function resolveSummaryModelSettings(
	options: AnalysisModelOptions,
	runtime: RuntimeServices = defaultRuntimeServices,
): SummaryModelSettings {
	const shared = resolveAnalysisModelSettings(options, runtime);
	const [primary] = resolveTargets(options, runtime);
	return {
		...shared,
		provider: primary?.provider ?? "openai",
		model: primary?.model ?? shared.model,
	};
}

function canonicalMessages(body: CanonicalAnalysisBody) {
	if (!Array.isArray(body.input)) return [];
	return body.input.flatMap((item) => {
		if (!item || typeof item !== "object") return [];
		const record = item as Record<string, unknown>;
		if (
			(record.role !== "system" && record.role !== "user") ||
			typeof record.content !== "string"
		) {
			return [];
		}
		return [{ role: record.role, content: record.content }];
	});
}

function deepSeekRequestBody(body: CanonicalAnalysisBody, model: string) {
	const maxTokens = Number(body.max_output_tokens);
	return {
		model,
		messages: canonicalMessages(body),
		stream: true,
		stream_options: { include_usage: true },
		thinking: { type: "disabled" },
		...(Number.isFinite(maxTokens) && maxTokens > 0
			? { max_tokens: Math.trunc(maxTokens) }
			: {}),
	};
}

function requestTargetEffect(
	target: SummaryModelTarget,
	body: CanonicalAnalysisBody,
	signal: AbortSignal | undefined,
	runtime: RuntimeServices,
) {
	if (!target.apiKey) {
		return Effect.fail(
			new Error(
				target.provider === "deepseek"
					? "DeepSeek API key is not configured"
					: "OPENAI_API_KEY is not set",
			),
		);
	}
	return requestOpenAIResponseEffect({
		body:
			target.provider === "deepseek"
				? deepSeekRequestBody(body, target.model)
				: { ...body, model: target.model },
		signal,
		runtime,
		apiKey: target.apiKey,
		baseUrl: target.baseUrl,
		path:
			target.provider === "deepseek" ? "/chat/completions" : "/v1/responses",
		providerLabel: target.provider === "deepseek" ? "DeepSeek" : "OpenAI",
	});
}

interface ChatStreamState {
	buffer: string;
	rawText: string;
	pendingVisible: string;
	jsonMode: boolean;
	usage?: unknown;
	error?: string;
}

function emitChatDelta(
	state: ChatStreamState,
	delta: string,
	onDelta: ((delta: string) => void) | undefined,
	delimiterPattern: RegExp,
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
	if (combined.length <= DELIMITER_HOLD) {
		state.pendingVisible = combined;
		return;
	}
	const visible = combined.slice(0, -DELIMITER_HOLD);
	state.pendingVisible = combined.slice(-DELIMITER_HOLD);
	if (visible) onDelta?.(visible);
}

function processChatSseChunk(
	state: ChatStreamState,
	chunk: string,
	onDelta: ((delta: string) => void) | undefined,
	delimiterPattern: RegExp,
) {
	state.buffer += chunk.replaceAll("\r\n", "\n");
	let boundary = state.buffer.indexOf("\n\n");
	while (boundary >= 0) {
		const block = state.buffer.slice(0, boundary);
		state.buffer = state.buffer.slice(boundary + 2);
		const data = block
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n");
		if (data && data !== "[DONE]") {
			try {
				const event = JSON.parse(data) as Record<string, unknown>;
				if (event.error && typeof event.error === "object") {
					state.error = redactProviderError(
						String(
							(event.error as { message?: unknown }).message ??
								"DeepSeek stream failed",
						),
					);
				}
				if (event.usage !== undefined && event.usage !== null) {
					state.usage = event.usage;
				}
				const choices = Array.isArray(event.choices) ? event.choices : [];
				const choice = choices[0];
				if (choice && typeof choice === "object") {
					const delta = (choice as { delta?: unknown }).delta;
					if (delta && typeof delta === "object") {
						const content = (delta as { content?: unknown }).content;
						if (typeof content === "string") {
							emitChatDelta(state, content, onDelta, delimiterPattern);
						}
					}
				}
			} catch {
				// A malformed provider event is ignored; terminal validation still applies.
			}
		}
		boundary = state.buffer.indexOf("\n\n");
	}
}

function readDeepSeekStreamEffect<T>(
	response: Response,
	{
		parse,
		fallback,
		onDelta,
		delimiterPattern,
	}: {
		parse: (value: unknown) => T;
		fallback: (markdown: string) => T;
		onDelta?: (delta: string) => void;
		delimiterPattern: RegExp;
	},
): Effect.Effect<HybridAnalysisResult<T>, Error> {
	const reader = response.body?.getReader();
	if (!reader)
		return Effect.fail(new Error("DeepSeek response did not include a stream"));
	const decoder = new TextDecoder();
	return Effect.gen(function* () {
		const state: ChatStreamState = {
			buffer: "",
			rawText: "",
			pendingVisible: "",
			jsonMode: false,
		};
		for (;;) {
			const { done, value } = yield* tryPromise(() => reader.read()).pipe(
				Effect.mapError(toError),
			);
			if (!done) {
				processChatSseChunk(
					state,
					decoder.decode(value, { stream: true }),
					onDelta,
					delimiterPattern,
				);
				continue;
			}
			if (!state.jsonMode && state.pendingVisible)
				onDelta?.(state.pendingVisible);
			if (state.error) return yield* Effect.fail(new Error(state.error));
			if (!state.rawText.trim()) {
				return yield* Effect.fail(
					new Error("DeepSeek returned no output text"),
				);
			}
			const parsed = parseHybridAnalysis({
				rawText: state.rawText,
				parse,
				fallback,
				delimiterPattern,
			});
			return {
				...parsed,
				rawText: state.rawText,
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

export function streamSummaryAnalysisEffect<T>({
	body,
	options,
	signal,
	runtime = defaultRuntimeServices,
	parse,
	fallback,
	onDelta,
	onFailover,
	bufferDeltasUntilSuccess = false,
	delimiterPattern = DEFAULT_DELIMITER_PATTERN,
}: {
	body: CanonicalAnalysisBody;
	options: AnalysisModelOptions;
	signal?: AbortSignal;
	runtime?: RuntimeServices;
	parse: (value: unknown) => T;
	fallback: (markdown: string) => T;
	onDelta?: (delta: string) => void;
	onFailover?: (target: {
		provider: SummaryModelProvider;
		model: string;
	}) => void;
	bufferDeltasUntilSuccess?: boolean;
	delimiterPattern?: RegExp;
}): Effect.Effect<HybridAnalysisResult<T>, Error> {
	return Effect.gen(function* () {
		const targets = resolveTargets(options, runtime);
		let lastError: Error | undefined;
		for (const [index, target] of targets.entries()) {
			if (index > 0) onFailover?.(target);
			let emitted = false;
			const bufferedDeltas: string[] = [];
			const emit = (delta: string) => {
				if (bufferDeltasUntilSuccess) {
					bufferedDeltas.push(delta);
					return;
				}
				emitted = true;
				onDelta?.(delta);
			};
			const attempt = Effect.gen(function* () {
				const response = yield* requestTargetEffect(
					target,
					body,
					signal,
					runtime,
				);
				return target.provider === "deepseek"
					? yield* readDeepSeekStreamEffect(response, {
							parse,
							fallback,
							onDelta: emit,
							delimiterPattern,
						})
					: yield* readHybridAnalysisStreamEffect(response, {
							parse,
							fallback,
							onDelta: emit,
							delimiterPattern,
						});
			});
			const outcome = yield* Effect.either(attempt);
			if (outcome._tag === "Right") {
				if (bufferDeltasUntilSuccess) {
					for (const delta of bufferedDeltas) onDelta?.(delta);
				}
				return {
					...outcome.right,
					provider: target.provider,
					model: target.model,
				};
			}
			lastError = toError(outcome.left);
			if (emitted || index === targets.length - 1) {
				return yield* Effect.fail(lastError);
			}
		}
		return yield* Effect.fail(
			lastError ?? new Error("No summary model is available"),
		);
	});
}

export const __test__ = {
	deepSeekRequestBody,
	processChatSseChunk,
	resolveTargets,
};
