import { jsonResponse } from "./http-effect";
import { normalizeTweetVideoCdnUrl } from "./tweet-video-url";

type FetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

const VIDEO_FETCH_TIMEOUT_MS = 30_000;
const FORWARDED_RESPONSE_HEADERS = [
	"accept-ranges",
	"cache-control",
	"content-length",
	"content-range",
	"etag",
	"last-modified",
] as const;

function validSingleByteRange(value: string) {
	return /^bytes=(?:\d+-\d*|-\d+)$/.test(value);
}

function safeErrorResponse(message: string, status: number) {
	return jsonResponse({ ok: false, message }, { status });
}

function copyUpstreamHeaders(upstream: Response) {
	const headers = new Headers({
		"content-type": "video/mp4",
		"referrer-policy": "no-referrer",
		vary: "range",
		"x-content-type-options": "nosniff",
	});
	for (const name of FORWARDED_RESPONSE_HEADERS) {
		const value = upstream.headers.get(name);
		if (value) headers.set(name, value);
	}
	return headers;
}

async function cancelBody(response: Response) {
	try {
		await response.body?.cancel();
	} catch {
		// The upstream may already have closed while the failure is handled.
	}
}

export async function proxyTweetVideoRequest(
	request: Request,
	fetchImpl: FetchLike = globalThis.fetch,
) {
	const requestUrl = new URL(request.url);
	const videoUrl = normalizeTweetVideoCdnUrl(
		requestUrl.searchParams.get("url"),
	);
	if (!videoUrl) {
		return safeErrorResponse("Invalid tweet video URL", 400);
	}

	const range = request.headers.get("range");
	if (range && !validSingleByteRange(range)) {
		return safeErrorResponse("Invalid video range", 416);
	}

	const upstreamHeaders = new Headers({
		accept: "video/mp4,video/*;q=0.9,*/*;q=0.1",
		"accept-encoding": "identity",
		"user-agent": "birdclaw/tweet-video",
	});
	if (range) upstreamHeaders.set("range", range);
	const ifRange = request.headers.get("if-range");
	if (ifRange) upstreamHeaders.set("if-range", ifRange);

	let upstream: Response;
	const headerTimeout = new AbortController();
	const headerTimeoutId = setTimeout(
		() => headerTimeout.abort(),
		VIDEO_FETCH_TIMEOUT_MS,
	);
	try {
		upstream = await fetchImpl(videoUrl, {
			headers: upstreamHeaders,
			redirect: "error",
			signal: AbortSignal.any([request.signal, headerTimeout.signal]),
		});
	} catch {
		return safeErrorResponse("Tweet video is unavailable", 502);
	} finally {
		clearTimeout(headerTimeoutId);
	}

	if (upstream.status === 416) {
		await cancelBody(upstream);
		const headers = copyUpstreamHeaders(upstream);
		headers.delete("content-length");
		return new Response(null, { status: 416, headers });
	}

	const contentType =
		upstream.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ??
		"";
	if (
		(upstream.status !== 200 && upstream.status !== 206) ||
		contentType !== "video/mp4" ||
		!upstream.body
	) {
		await cancelBody(upstream);
		return safeErrorResponse("Tweet video is unavailable", 502);
	}

	return new Response(upstream.body, {
		status: upstream.status,
		headers: copyUpstreamHeaders(upstream),
	});
}
