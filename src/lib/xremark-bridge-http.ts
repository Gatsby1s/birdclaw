import { jsonResponse } from "./http-effect";
import {
	XREMARK_EXTENSION_ORIGIN,
	XREMARK_PUBLIC_ORIGIN,
} from "./xremark-live";

export function xRemarkBridgeCorsHeaders() {
	return {
		"access-control-allow-origin": XREMARK_EXTENSION_ORIGIN,
		"access-control-allow-methods": "GET, POST, OPTIONS",
		"access-control-allow-headers": "authorization, content-type",
		"access-control-max-age": "600",
		vary: "Origin",
	};
}

export function xRemarkBridgeJsonResponse(data: unknown, init?: ResponseInit) {
	return jsonResponse(data, {
		...init,
		headers: { ...xRemarkBridgeCorsHeaders(), ...init?.headers },
	});
}

function isLoopbackHost(hostname: string) {
	return (
		hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
	);
}

export function xRemarkBridgeRequestDenied(request: Request) {
	const url = new URL(request.url);
	const allowedTarget =
		url.origin === XREMARK_PUBLIC_ORIGIN ||
		(isLoopbackHost(url.hostname) && url.protocol === "http:");
	if (!allowedTarget) {
		return jsonResponse(
			{ ok: false, message: "Untrusted BirdClaw X Remark sync target." },
			{ status: 403 },
		);
	}
	if (request.headers.get("origin") !== XREMARK_EXTENSION_ORIGIN) {
		return jsonResponse(
			{ ok: false, message: "Untrusted X Remark extension origin." },
			{ status: 403 },
		);
	}
	return null;
}

export function xRemarkBearerToken(request: Request) {
	const authorization = request.headers.get("authorization") ?? "";
	const match = authorization.match(/^Bearer ([A-Za-z0-9_-]{40,128})$/);
	return match?.[1] ?? null;
}
