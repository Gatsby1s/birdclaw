// @vitest-environment node
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
	extractDeepSeekChatCompletionText,
	redactDeepSeekError,
	requestDeepSeekChatCompletionEffect,
	resolveDeepSeekUrl,
} from "./deepseek-chat-runtime";
import { createRuntimeServices } from "./runtime-services";

describe("DeepSeek chat runtime", () => {
	it("resolves the official and configurable chat completion URLs", () => {
		expect(resolveDeepSeekUrl()).toBe(
			"https://api.deepseek.com/chat/completions",
		);
		expect(resolveDeepSeekUrl("https://gateway.example.test/v1/")).toBe(
			"https://gateway.example.test/v1/chat/completions",
		);
	});

	it("extracts the assistant content from a chat completion", () => {
		expect(
			extractDeepSeekChatCompletionText({
				choices: [{ message: { content: '{"translatedText":"译文"}' } }],
			}),
		).toBe('{"translatedText":"译文"}');
		expect(extractDeepSeekChatCompletionText({ choices: [] })).toBe("");
	});

	it("requires its own credential", async () => {
		const runtime = createRuntimeServices({
			env: (name) => (name === "OPENAI_API_KEY" ? "openai-key" : undefined),
			fetch: vi.fn(),
		});

		await expect(
			Effect.runPromise(
				requestDeepSeekChatCompletionEffect({ body: {}, runtime }),
			),
		).rejects.toThrow("DEEPSEEK_API_KEY is not set");
		expect(runtime.fetch).not.toHaveBeenCalled();
	});

	it("uses the DeepSeek key and base URL without affecting OpenAI settings", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response("{}", { status: 200 }));
		const runtime = createRuntimeServices({
			env: (name) => {
				if (name === "DEEPSEEK_API_KEY") return "deepseek-key";
				if (name === "DEEPSEEK_BASE_URL") {
					return "https://gateway.example.test/v1";
				}
				if (name === "OPENAI_API_KEY") return "openai-key";
				if (name === "OPENAI_BASE_URL") return "https://openai.example.test";
				return undefined;
			},
			fetch: fetchMock,
		});

		await Effect.runPromise(
			requestDeepSeekChatCompletionEffect({
				body: { model: "deepseek-v4-flash" },
				runtime,
			}),
		);

		expect(fetchMock).toHaveBeenCalledWith(
			"https://gateway.example.test/v1/chat/completions",
			expect.objectContaining({
				headers: expect.objectContaining({
					authorization: "Bearer deepseek-key",
				}),
			}),
		);
	});

	it("retries transient errors and redacts secrets from the final error", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("busy", { status: 503 }))
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						error: { message: "rejected sk-sensitive-value-1234567890" },
					}),
					{ status: 401 },
				),
			);
		const runtime = createRuntimeServices({
			env: (name) => (name === "DEEPSEEK_API_KEY" ? "test-key" : undefined),
			fetch: fetchMock,
			random: () => 0,
		});

		await expect(
			Effect.runPromise(
				requestDeepSeekChatCompletionEffect({
					body: {},
					maxRetries: 1,
					retryBaseDelayMs: 0,
					runtime,
				}),
			),
		).rejects.toThrow("DeepSeek request failed: 401 rejected sk-sens...7890");
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(redactDeepSeekError("bad sk-sensitive-value-1234567890")).toBe(
			"bad sk-sens...7890",
		);
	});
});
