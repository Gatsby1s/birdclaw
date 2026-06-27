// @vitest-environment node
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createOpenAIStreamState,
	processOpenAIResponseSseChunk,
	readOpenAIResponseStreamEffect,
	redactOpenAIError,
	requestOpenAIResponseEffect,
	resolveOpenAIUrl,
} from "./openai-response-runtime";

afterEach(() => {
	delete process.env.OPENAI_API_KEY;
	delete process.env.OPENAI_BASE_URL;
	vi.unstubAllGlobals();
});

describe("OpenAI response runtime", () => {
	it("streams visible markdown while retaining hybrid output and metadata", async () => {
		const visible: string[] = [];
		const stream = new ReadableStream({
			start(controller) {
				for (const event of [
					{ type: "response.output_text.delta", delta: "Hello\n-" },
					{ type: "response.output_text.delta", delta: '--\n{"ok":true}' },
					{
						type: "response.completed",
						response: { id: "resp_1", usage: { output_tokens: 2 } },
					},
				]) {
					controller.enqueue(
						new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`),
					);
				}
				controller.close();
			},
		});
		const result = await Effect.runPromise(
			readOpenAIResponseStreamEffect(new Response(stream), {
				onDelta: (delta) => visible.push(delta),
			}),
		);

		expect(visible.join("")).toBe("Hello");
		expect(result).toEqual({
			rawText: 'Hello\n---\n{"ok":true}',
			responseId: "resp_1",
			usage: { output_tokens: 2 },
		});
	});

	it("retains incomplete SSE frames and ignores malformed events", () => {
		const state = createOpenAIStreamState();
		processOpenAIResponseSseChunk(state, "data: {bad}\n\n");
		processOpenAIResponseSseChunk(
			state,
			`data: ${JSON.stringify({
				type: "response.output_text.delta",
				delta: "ok",
			})}`,
		);
		expect(state.rawText).toBe("");
		processOpenAIResponseSseChunk(state, "\n\n");
		expect(state.rawText).toBe("ok");
	});

	it("checks credentials and HTTP failures centrally", async () => {
		await expect(
			Effect.runPromise(requestOpenAIResponseEffect({ body: {} })),
		).rejects.toThrow("OPENAI_API_KEY");

		process.env.OPENAI_API_KEY = "test";
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("bad request", { status: 400 })),
		);
		await expect(
			Effect.runPromise(requestOpenAIResponseEffect({ body: {} })),
		).rejects.toThrow("400 bad request");
	});

	it("builds OpenAI-compatible URLs from custom base URLs", () => {
		expect(resolveOpenAIUrl("/v1/responses")).toBe(
			"https://api.openai.com/v1/responses",
		);
		expect(resolveOpenAIUrl("/v1/responses", "http://127.0.0.1:8080")).toBe(
			"http://127.0.0.1:8080/v1/responses",
		);
		expect(resolveOpenAIUrl("/v1/responses", "http://127.0.0.1:8080/v1")).toBe(
			"http://127.0.0.1:8080/v1/responses",
		);
	});

	it("uses OPENAI_BASE_URL and redacts API keys from HTTP failures", async () => {
		process.env.OPENAI_API_KEY = "test";
		process.env.OPENAI_BASE_URL = "http://127.0.0.1:8080";
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				new Response(
					"Incorrect API key provided: sk-a69a0abcdefghijklmnopqrstuvwxyzf13a",
					{ status: 401 },
				),
			);
		vi.stubGlobal("fetch", fetchMock);

		let message = "";
		try {
			await Effect.runPromise(requestOpenAIResponseEffect({ body: {} }));
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("sk-a69a...f13a");
		expect(message).not.toContain("sk-a69a0abcdefghijklmnopqrstuvwxyzf13a");
		expect(fetchMock).toHaveBeenCalledWith(
			"http://127.0.0.1:8080/v1/responses",
			expect.any(Object),
		);
		expect(redactOpenAIError("short sk-abcd")).toBe("short sk-...");
	});
});
