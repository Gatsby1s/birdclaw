// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";
import { Route } from "./tweet-video";

const GET = getRouteHandler(Route, "GET");
const validUrl =
	"https://video.twimg.com/ext_tw_video/2080991659115122688/vid/avc1/clip.mp4?tag=29";

function request(url = validUrl, headers?: HeadersInit, signal?: AbortSignal) {
	const query = new URLSearchParams({ url });
	return new Request(`http://localhost/api/tweet-video?${query.toString()}`, {
		headers,
		signal,
	});
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("tweet video api route", () => {
	it("streams a complete MP4 response with safe headers", async () => {
		let canceled = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1, 2, 3]));
			},
			cancel() {
				canceled = true;
			},
		});
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(body, {
				status: 200,
				headers: {
					"accept-ranges": "bytes",
					"content-length": "3",
					"content-type": "video/mp4",
				},
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const response = await GET({ request: request() });

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("video/mp4");
		expect(response.headers.get("content-length")).toBe("3");
		expect(response.headers.get("accept-ranges")).toBe("bytes");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		await response.body?.cancel();
		expect(canceled).toBe(true);
	});

	it("forwards a single byte range and preserves a partial response", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(new Uint8Array([10, 11, 12, 13]), {
				status: 206,
				headers: {
					"accept-ranges": "bytes",
					"content-length": "4",
					"content-range": "bytes 10-13/100",
					"content-type": "video/mp4",
					etag: '"video-etag"',
				},
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const response = await GET({
			request: request(validUrl, {
				range: "bytes=10-13",
				"if-range": '"video-etag"',
			}),
		});

		expect(fetchMock).toHaveBeenCalledOnce();
		const [upstreamUrl, init] = fetchMock.mock.calls[0] as [
			string,
			RequestInit,
		];
		expect(upstreamUrl).toBe(validUrl);
		expect(new Headers(init.headers).get("range")).toBe("bytes=10-13");
		expect(new Headers(init.headers).get("if-range")).toBe('"video-etag"');
		expect(new Headers(init.headers).get("accept-encoding")).toBe("identity");
		expect(init.redirect).toBe("error");
		expect(response.status).toBe(206);
		expect(response.headers.get("content-range")).toBe("bytes 10-13/100");
		expect(response.headers.get("content-length")).toBe("4");
		expect(response.headers.get("etag")).toBe('"video-etag"');
		expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([
			10, 11, 12, 13,
		]);
	});

	it("preserves an upstream unsatisfied range without proxying its body", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response("ignored", {
				status: 416,
				headers: {
					"content-range": "bytes */100",
					"content-type": "text/plain",
				},
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const response = await GET({
			request: request(validUrl, { range: "bytes=500-" }),
		});

		expect(response.status).toBe(416);
		expect(response.headers.get("content-range")).toBe("bytes */100");
		expect(await response.text()).toBe("");
	});

	it.each([
		["missing", null],
		["http", "http://video.twimg.com/ext_tw_video/clip.mp4"],
		["credentials", "https://user:pass@video.twimg.com/ext_tw_video/clip.mp4"],
		["port", "https://video.twimg.com:444/ext_tw_video/clip.mp4"],
		["lookalike", "https://video.twimg.com.evil.test/ext_tw_video/clip.mp4"],
		["private host", "https://127.0.0.1/ext_tw_video/clip.mp4"],
		["unknown path", "https://video.twimg.com/other/clip.mp4"],
		["not mp4", "https://video.twimg.com/ext_tw_video/playlist.m3u8"],
	])("rejects an invalid %s URL before fetching", async (_label, value) => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const query =
			value === null
				? ""
				: `?${new URLSearchParams({ url: value }).toString()}`;

		const response = await GET({
			request: new Request(`http://localhost/api/tweet-video${query}`),
		});

		expect(response.status).toBe(400);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each(["bytes=0-1,4-5", "items=0-10", "bytes=-", "bytes=abc-10"])(
		"rejects malformed or multiple ranges before fetching",
		async (range) => {
			const fetchMock = vi.fn();
			vi.stubGlobal("fetch", fetchMock);

			const response = await GET({
				request: request(validUrl, { range }),
			});

			expect(response.status).toBe(416);
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it("sanitizes fetch failures, redirects, and non-video responses", async () => {
		for (const result of [
			Promise.reject(new Error(`private failure for ${validUrl}`)),
			Promise.resolve(new Response(null, { status: 302 })),
			Promise.resolve(
				new Response("<html>blocked</html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
			),
		]) {
			const fetchMock = vi.fn().mockReturnValue(result);
			vi.stubGlobal("fetch", fetchMock);
			const response = await GET({ request: request() });

			expect(response.status).toBe(502);
			const text = await response.text();
			expect(text).not.toContain(validUrl);
			expect(text).not.toContain("private failure");
		}
	});

	it("links the upstream request to the browser request abort signal", async () => {
		const controller = new AbortController();
		let upstreamSignal: AbortSignal | undefined;
		const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
			upstreamSignal = init?.signal ?? undefined;
			return new Promise<Response>((_resolve, reject) => {
				upstreamSignal?.addEventListener(
					"abort",
					() => reject(new DOMException("Aborted", "AbortError")),
					{ once: true },
				);
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const responsePromise = GET({
			request: request(validUrl, undefined, controller.signal),
		});
		controller.abort();
		const response = await responsePromise;

		expect(upstreamSignal?.aborted).toBe(true);
		expect(response.status).toBe(502);
	});

	it("clears the response-header timeout before streaming a slow body", async () => {
		vi.useFakeTimers();
		let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				bodyController = controller;
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(body, {
					status: 206,
					headers: {
						"content-type": "video/mp4",
						"content-range": "bytes 0-2/3",
					},
				}),
			),
		);

		const response = await GET({ request: request() });
		await vi.advanceTimersByTimeAsync(30_001);
		bodyController?.enqueue(new Uint8Array([1, 2, 3]));
		bodyController?.close();

		expect(response.status).toBe(206);
		expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([
			1, 2, 3,
		]);
	});

	it("times out while waiting for upstream response headers", async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener(
					"abort",
					() => reject(new DOMException("Aborted", "AbortError")),
					{ once: true },
				);
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const responsePromise = GET({ request: request() });
		await vi.advanceTimersByTimeAsync(30_001);
		const response = await responsePromise;

		expect(response.status).toBe(502);
	});
});
