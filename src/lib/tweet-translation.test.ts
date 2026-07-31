// @vitest-environment node
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeServices } from "./runtime-services";
import type { readSyncCache, writeSyncCache } from "./sync-cache";
import { shouldAutoTranslateTweetText } from "./tweet-language";
import { translateTweetTextEffect } from "./tweet-translation";

describe("tweet translation", () => {
	it("only sends likely non-Chinese language text for translation", () => {
		expect(
			shouldAutoTranslateTweetText("今天发布 BirdClaw，新版本更快。"),
		).toBe(false);
		expect(
			shouldAutoTranslateTweetText("今天发布 BirdClaw v2，Chrome 也更快。"),
		).toBe(false);
		expect(
			shouldAutoTranslateTweetText("Shipping the new release today."),
		).toBe(true);
		expect(shouldAutoTranslateTweetText("Great work 腾讯")).toBe(true);
		expect(shouldAutoTranslateTweetText("@AI #AI https://example.com")).toBe(
			false,
		);
		expect(shouldAutoTranslateTweetText("새 버전을 오늘 출시합니다.")).toBe(
			true,
		);
		expect(shouldAutoTranslateTweetText("新しいバージョンを公開します。")).toBe(
			true,
		);
		expect(shouldAutoTranslateTweetText("🚀 https://example.com")).toBe(false);
	});

	it("returns a valid cached translation without calling OpenAI", async () => {
		const runtime = createRuntimeServices({ fetch: vi.fn() });
		const readCache = vi.fn(() => ({
			value: {
				sourceLanguage: "English",
				translated: true,
				translatedText: "今天发布新版本。",
			},
			updatedAt: "2026-07-31T00:00:00.000Z",
		})) as unknown as typeof readSyncCache;

		await expect(
			Effect.runPromise(
				translateTweetTextEffect("Shipping the new release today.", {
					readCache,
					runtime,
				}),
			),
		).resolves.toEqual({
			targetLanguage: "zh-CN",
			sourceLanguage: "English",
			translated: true,
			translatedText: "今天发布新版本。",
			cached: true,
		});
		expect(runtime.fetch).not.toHaveBeenCalled();
	});

	it("translates with the shared Responses API and caches the result", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					output_text: JSON.stringify({
						sourceLanguage: "Korean",
						isChinese: false,
						translatedText: "今天发布新版本。 @birdclaw #launch",
					}),
				}),
				{ status: 200 },
			),
		);
		const runtime = createRuntimeServices({
			env: (name) => {
				if (name === "OPENAI_API_KEY") return "test-key";
				if (name === "BIRDCLAW_TRANSLATION_MODEL") {
					return "translation-model";
				}
				return undefined;
			},
			fetch: fetchMock,
		});
		const writeCache = vi.fn(
			() => "2026-07-31T00:00:00.000Z",
		) as unknown as typeof writeSyncCache;

		await expect(
			Effect.runPromise(
				translateTweetTextEffect(
					"새 버전을 오늘 출시합니다. @birdclaw #launch",
					{
						readCache: vi.fn(() => null) as unknown as typeof readSyncCache,
						runtime,
						writeCache,
					},
				),
			),
		).resolves.toEqual({
			targetLanguage: "zh-CN",
			sourceLanguage: "Korean",
			translated: true,
			translatedText: "今天发布新版本。 @birdclaw #launch",
			cached: false,
		});

		const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
		const body = JSON.parse(String(request.body)) as {
			model: string;
			reasoning: { effort: string };
			service_tier: string;
			input: Array<{ content: string }>;
		};
		expect(body.model).toBe("translation-model");
		expect(body.reasoning.effort).toBe("minimal");
		expect(body.service_tier).toBe("default");
		expect(body.input[1]?.content).toContain(
			"새 버전을 오늘 출시합니다. @birdclaw #launch",
		);
		expect(writeCache).toHaveBeenCalledOnce();
	});

	it("does not call OpenAI for an already-Chinese post", async () => {
		const runtime = createRuntimeServices({ fetch: vi.fn() });
		await expect(
			Effect.runPromise(
				translateTweetTextEffect("今天发布新版本。", { runtime }),
			),
		).resolves.toEqual({
			targetLanguage: "zh-CN",
			sourceLanguage: "Chinese",
			translated: false,
			translatedText: "今天发布新版本。",
			cached: true,
		});
		expect(runtime.fetch).not.toHaveBeenCalled();
	});

	it("rejects malformed model output instead of caching it", async () => {
		const runtime = createRuntimeServices({
			env: (name) => (name === "OPENAI_API_KEY" ? "test-key" : undefined),
			fetch: vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ output_text: "not json" }), {
					status: 200,
				}),
			),
		});
		const writeCache = vi.fn(
			() => "2026-07-31T00:00:00.000Z",
		) as unknown as typeof writeSyncCache;

		await expect(
			Effect.runPromise(
				translateTweetTextEffect("This needs translation.", {
					readCache: vi.fn(() => null) as unknown as typeof readSyncCache,
					runtime,
					writeCache,
				}),
			),
		).rejects.toThrow("valid JSON");
		expect(writeCache).not.toHaveBeenCalled();
	});

	it("deduplicates concurrent requests for the same text", async () => {
		const cache = new Map<string, { value: unknown; updatedAt: string }>();
		const readCache = vi.fn((key: string) => cache.get(key) ?? null);
		const writeCache = vi.fn((key: string, value: unknown) => {
			const updatedAt = "2026-07-31T00:00:00.000Z";
			cache.set(key, { value, updatedAt });
			return updatedAt;
		});
		const fetchMock = vi.fn(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			return new Response(
				JSON.stringify({
					output_text: JSON.stringify({
						sourceLanguage: "English",
						isChinese: false,
						translatedText: "只应请求一次。",
					}),
				}),
				{ status: 200 },
			);
		});
		const runtime = createRuntimeServices({
			env: (name) => (name === "OPENAI_API_KEY" ? "test-key" : undefined),
			fetch: fetchMock,
		});

		const results = await Promise.all([
			Effect.runPromise(
				translateTweetTextEffect("Translate this only once.", {
					readCache: readCache as unknown as typeof readSyncCache,
					runtime,
					writeCache: writeCache as unknown as typeof writeSyncCache,
				}),
			),
			Effect.runPromise(
				translateTweetTextEffect("Translate this only once.", {
					readCache: readCache as unknown as typeof readSyncCache,
					runtime,
					writeCache: writeCache as unknown as typeof writeSyncCache,
				}),
			),
		]);

		expect(fetchMock).toHaveBeenCalledOnce();
		expect(writeCache).toHaveBeenCalledOnce();
		expect(results.map((result) => result.cached)).toEqual([false, true]);
	});

	it("returns a successful translation when the local cache write fails", async () => {
		const runtime = createRuntimeServices({
			env: (name) => (name === "OPENAI_API_KEY" ? "test-key" : undefined),
			fetch: vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						output_text: JSON.stringify({
							sourceLanguage: "English",
							isChinese: false,
							translatedText: "缓存失败也能显示译文。",
						}),
					}),
					{ status: 200 },
				),
			),
		});

		await expect(
			Effect.runPromise(
				translateTweetTextEffect("Show this even if caching fails.", {
					readCache: vi.fn(() => null) as unknown as typeof readSyncCache,
					runtime,
					writeCache: vi.fn(() => {
						throw new Error("disk full");
					}) as unknown as typeof writeSyncCache,
				}),
			),
		).resolves.toMatchObject({
			translated: true,
			translatedText: "缓存失败也能显示译文。",
		});
	});
});
