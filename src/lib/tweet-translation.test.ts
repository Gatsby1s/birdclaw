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

	it("returns a valid cached translation without calling DeepSeek", async () => {
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

	it("translates with DeepSeek V4 Flash and caches the result", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								content: JSON.stringify({
									sourceLanguage: "Korean",
									isChinese: false,
									translatedText: "今天发布新版本。 @birdclaw #launch",
								}),
							},
						},
					],
				}),
				{ status: 200 },
			),
		);
		const runtime = createRuntimeServices({
			env: (name) => {
				if (name === "DEEPSEEK_API_KEY") return "test-key";
				if (name === "BIRDCLAW_AI_MODEL") return "gpt-5.6-sol";
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
			thinking: { type: string };
			response_format: { type: string };
			messages: Array<{ content: string }>;
		};
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"https://api.deepseek.com/chat/completions",
		);
		expect(body.model).toBe("deepseek-v4-flash");
		expect(body.thinking.type).toBe("disabled");
		expect(body.response_format.type).toBe("json_object");
		expect(body.messages[1]?.content).toContain(
			"새 버전을 오늘 출시합니다. @birdclaw #launch",
		);
		expect(writeCache).toHaveBeenCalledOnce();
	});

	it("namespaces the cache with a translation-only model override", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								content: JSON.stringify({
									sourceLanguage: "English",
									isChinese: false,
									translatedText: "独立模型缓存。",
								}),
							},
						},
					],
				}),
				{ status: 200 },
			),
		);
		const runtime = createRuntimeServices({
			env: (name) => {
				if (name === "DEEPSEEK_API_KEY") return "test-key";
				if (name === "BIRDCLAW_TRANSLATION_MODEL") {
					return "deepseek-v4-pro";
				}
				if (name === "BIRDCLAW_AI_MODEL") return "gpt-5.6-sol";
				return undefined;
			},
			fetch: fetchMock,
		});
		const readCacheMock = vi.fn((_key: string) => null);

		await Effect.runPromise(
			translateTweetTextEffect("Use the dedicated translation model.", {
				readCache: readCacheMock as unknown as typeof readSyncCache,
				runtime,
				writeCache: vi.fn(
					() => "2026-07-31T00:00:00.000Z",
				) as unknown as typeof writeSyncCache,
			}),
		);

		const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
		const body = JSON.parse(String(request.body)) as { model: string };
		expect(body.model).toBe("deepseek-v4-pro");
		expect(readCacheMock.mock.calls[0]?.[0]).toContain(
			":deepseek-deepseek-v4-pro:",
		);
	});

	it("does not call DeepSeek for an already-Chinese post", async () => {
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
			env: (name) => (name === "DEEPSEEK_API_KEY" ? "test-key" : undefined),
			fetch: vi
				.fn()
				.mockResolvedValue(
					new Response(
						JSON.stringify({ choices: [{ message: { content: "not json" } }] }),
						{ status: 200 },
					),
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
					choices: [
						{
							message: {
								content: JSON.stringify({
									sourceLanguage: "English",
									isChinese: false,
									translatedText: "只应请求一次。",
								}),
							},
						},
					],
				}),
				{ status: 200 },
			);
		});
		const runtime = createRuntimeServices({
			env: (name) => (name === "DEEPSEEK_API_KEY" ? "test-key" : undefined),
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
			env: (name) => (name === "DEEPSEEK_API_KEY" ? "test-key" : undefined),
			fetch: vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						choices: [
							{
								message: {
									content: JSON.stringify({
										sourceLanguage: "English",
										isChinese: false,
										translatedText: "缓存失败也能显示译文。",
									}),
								},
							},
						],
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

	it("does not fall back to the global OpenAI credential", async () => {
		const runtime = createRuntimeServices({
			env: (name) => (name === "OPENAI_API_KEY" ? "openai-key" : undefined),
			fetch: vi.fn(),
		});

		await expect(
			Effect.runPromise(
				translateTweetTextEffect("This must use the translation provider.", {
					readCache: vi.fn(() => null) as unknown as typeof readSyncCache,
					runtime,
				}),
			),
		).rejects.toThrow("DEEPSEEK_API_KEY is not set");
		expect(runtime.fetch).not.toHaveBeenCalled();
	});

	it("translates through an explicitly selected OpenAI-compatible primary", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			Response.json({
				choices: [
					{
						message: {
							content: JSON.stringify({
								sourceLanguage: "English",
								isChinese: false,
								translatedText: "由 Sub2API 完成翻译。",
							}),
						},
					},
				],
			}),
		);
		const runtime = createRuntimeServices({
			env: (name) => {
				if (name === "BIRDCLAW_TRANSLATION_PRIMARY_PROVIDER") return "openai";
				if (name === "BIRDCLAW_TRANSLATION_BACKUP_PROVIDER") {
					return "deepseek";
				}
				if (name === "BIRDCLAW_TRANSLATION_OPENAI_MODEL") return "gpt-5.6";
				if (name === "OPENAI_API_KEY") return "openai-test-key";
				if (name === "OPENAI_BASE_URL") return "http://sub2api.internal:8080";
				if (name === "DEEPSEEK_API_KEY") return "deepseek-test-key";
				return undefined;
			},
			fetch: fetchMock,
		});

		await expect(
			Effect.runPromise(
				translateTweetTextEffect("Translate through the gateway.", {
					readCache: vi.fn(() => null) as unknown as typeof readSyncCache,
					runtime,
					writeCache: vi.fn(
						() => "2026-08-17T00:00:00.000Z",
					) as unknown as typeof writeSyncCache,
				}),
			),
		).resolves.toMatchObject({
			translated: true,
			translatedText: "由 Sub2API 完成翻译。",
		});

		expect(fetchMock).toHaveBeenCalledOnce();
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"http://sub2api.internal:8080/v1/chat/completions",
		);
		const request = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
		expect(request).toBeDefined();
		const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
		expect(body.model).toBe("gpt-5.6");
		expect(body).not.toHaveProperty("thinking");
	});

	it("falls back after malformed primary output and caches the backup result", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json({
					choices: [{ message: { content: "not valid json" } }],
				}),
			)
			.mockResolvedValueOnce(
				Response.json({
					choices: [
						{
							message: {
								content: JSON.stringify({
									sourceLanguage: "English",
									isChinese: false,
									translatedText: "备用模型接管成功。",
								}),
							},
						},
					],
				}),
			);
		const runtime = createRuntimeServices({
			env: (name) => {
				if (name === "BIRDCLAW_TRANSLATION_PRIMARY_PROVIDER") {
					return "deepseek";
				}
				if (name === "BIRDCLAW_TRANSLATION_BACKUP_PROVIDER") return "openai";
				if (name === "DEEPSEEK_API_KEY") return "deepseek-test-key";
				if (name === "OPENAI_API_KEY") return "openai-test-key";
				if (name === "OPENAI_BASE_URL") return "https://gateway.example";
				return undefined;
			},
			fetch: fetchMock,
		});
		const writeCacheMock = vi.fn(
			(_key: string, _value: unknown) => "2026-08-17T00:00:00.000Z",
		);
		const writeCache = writeCacheMock as unknown as typeof writeSyncCache;

		await expect(
			Effect.runPromise(
				translateTweetTextEffect("Use the backup if needed.", {
					readCache: vi.fn(() => null) as unknown as typeof readSyncCache,
					runtime,
					writeCache,
				}),
			),
		).resolves.toMatchObject({ translatedText: "备用模型接管成功。" });
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"https://api.deepseek.com/chat/completions",
		);
		expect(fetchMock.mock.calls[1]?.[0]).toBe(
			"https://gateway.example/v1/chat/completions",
		);
		expect(writeCacheMock).toHaveBeenCalledOnce();
		expect(String(writeCacheMock.mock.calls[0]?.[0])).toContain(
			"deepseek-deepseek-v4-flash-then-openai-gpt-5.5",
		);
	});

	it("falls back when the primary credential is not configured", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			Response.json({
				choices: [
					{
						message: {
							content: JSON.stringify({
								sourceLanguage: "English",
								isChinese: false,
								translatedText: "缺少主密钥时由备用模型翻译。",
							}),
						},
					},
				],
			}),
		);
		const runtime = createRuntimeServices({
			env: (name) => {
				if (name === "BIRDCLAW_TRANSLATION_PRIMARY_PROVIDER") {
					return "deepseek";
				}
				if (name === "BIRDCLAW_TRANSLATION_BACKUP_PROVIDER") return "openai";
				if (name === "OPENAI_API_KEY") return "openai-test-key";
				return undefined;
			},
			fetch: fetchMock,
		});

		await expect(
			Effect.runPromise(
				translateTweetTextEffect("Use backup without the primary key.", {
					readCache: vi.fn(() => null) as unknown as typeof readSyncCache,
					runtime,
					writeCache: vi.fn(
						() => "2026-08-17T00:00:00.000Z",
					) as unknown as typeof writeSyncCache,
				}),
			),
		).resolves.toMatchObject({
			translatedText: "缺少主密钥时由备用模型翻译。",
		});
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"https://api.openai.com/v1/chat/completions",
		);
	});

	it("does not start a backup request after cancellation", async () => {
		const controller = new AbortController();
		controller.abort(new DOMException("cancelled", "AbortError"));
		const fetchMock = vi.fn();
		const runtime = createRuntimeServices({
			env: (name) => {
				if (name === "BIRDCLAW_TRANSLATION_PRIMARY_PROVIDER") {
					return "deepseek";
				}
				if (name === "BIRDCLAW_TRANSLATION_BACKUP_PROVIDER") return "openai";
				if (name === "DEEPSEEK_API_KEY") return "deepseek-test-key";
				if (name === "OPENAI_API_KEY") return "openai-test-key";
				return undefined;
			},
			fetch: fetchMock,
		});

		await expect(
			Effect.runPromise(
				translateTweetTextEffect("Cancel this translation.", {
					readCache: vi.fn(() => null) as unknown as typeof readSyncCache,
					runtime,
					signal: controller.signal,
				}),
			),
		).rejects.toThrow("cancelled");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
