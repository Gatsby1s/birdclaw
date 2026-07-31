import { createHmac, timingSafeEqual } from "node:crypto";
import { Effect } from "effect";
import { runEffectPromise, tryPromise } from "./effect-runtime";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
export const LOCAL_WEB_PEER_HEADER = "x-birdclaw-local-peer";

export function jsonResponse(data: unknown, init?: ResponseInit) {
	const headers = new Headers(init?.headers);
	headers.set("content-type", "application/json");
	return new Response(JSON.stringify(data), {
		...init,
		headers,
	});
}

export function requestJsonEffect<T = Record<string, unknown>>(
	request: Request,
	fallback?: T,
): Effect.Effect<T, unknown> {
	return tryPromise(() => request.json() as Promise<T>).pipe(
		Effect.catchAll((error) =>
			fallback === undefined ? Effect.fail(error) : Effect.succeed(fallback),
		),
	);
}

export function runRouteEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
	return runEffectPromise(effect);
}

function normalizedHost(value: string) {
	return value.toLowerCase().replace(/^\[|\]$/g, "");
}

function isTestEnvironment() {
	return process.env.NODE_ENV === "test" || process.env.VITEST === "true";
}

function requestCookie(request: Request, name: string) {
	const cookie = request.headers.get("cookie");
	if (!cookie) return { found: false, value: null };
	for (const part of cookie.split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) {
			try {
				return { found: true, value: decodeURIComponent(rest.join("=")) };
			} catch {
				return { found: true, value: null };
			}
		}
	}
	return { found: false, value: null };
}

function configuredWebToken() {
	const token = process.env.BIRDCLAW_WEB_TOKEN?.trim();
	return token || null;
}

const WEB_SESSION_COOKIE = "birdclaw_session";
const WEB_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

function constantTimeEqual(left: string, right: string) {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	if (leftBuffer.length !== rightBuffer.length) return false;
	return timingSafeEqual(leftBuffer, rightBuffer);
}

function sessionSignature(expiresAt: string, token: string) {
	return createHmac("sha256", token)
		.update(`birdclaw-web-session:${expiresAt}`)
		.digest("base64url");
}

export function verifyBirdclawWebToken(candidate: string) {
	const token = configuredWebToken();
	return Boolean(token && constantTimeEqual(candidate, token));
}

export function hasValidBirdclawWebSession(request: Request) {
	const token = configuredWebToken();
	if (!token) return false;
	const value = requestCookie(request, WEB_SESSION_COOKIE).value;
	if (!value) return false;
	const [expiresAt, signature] = value.split(".");
	if (!expiresAt || !signature || !/^\d+$/.test(expiresAt)) return false;
	if (Number(expiresAt) <= Math.floor(Date.now() / 1000)) return false;
	return constantTimeEqual(signature, sessionSignature(expiresAt, token));
}

export function createBirdclawWebSessionCookie({
	secure,
}: {
	secure: boolean;
}) {
	const token = configuredWebToken();
	if (!token) throw new Error("BIRDCLAW_WEB_TOKEN is not configured");
	const expiresAt = String(
		Math.floor(Date.now() / 1000) + WEB_SESSION_TTL_SECONDS,
	);
	const value = `${expiresAt}.${sessionSignature(expiresAt, token)}`;
	return [
		`${WEB_SESSION_COOKIE}=${encodeURIComponent(value)}`,
		"Path=/",
		"HttpOnly",
		"SameSite=Lax",
		`Max-Age=${String(WEB_SESSION_TTL_SECONDS)}`,
		...(secure ? ["Secure"] : []),
	].join("; ");
}

export function clearBirdclawWebSessionCookie({ secure }: { secure: boolean }) {
	return [
		`${WEB_SESSION_COOKIE}=`,
		"Path=/",
		"HttpOnly",
		"SameSite=Lax",
		"Max-Age=0",
		...(secure ? ["Secure"] : []),
	].join("; ");
}

export function isBirdclawWebTokenConfigured() {
	return Boolean(configuredWebToken());
}

function requestWebTokenStatus(request: Request) {
	const token = configuredWebToken();
	if (!token)
		return {
			configured: false,
			valid: false,
			fromCookie: false,
			provided: false,
		};
	const headerToken = request.headers.get("x-birdclaw-token");
	const cookieToken = requestCookie(request, "birdclaw_token");
	const sessionCookie = requestCookie(request, WEB_SESSION_COOKIE);
	const provided =
		headerToken !== null || cookieToken.found || sessionCookie.found;
	const cookieValue = cookieToken.value;
	const sessionValid = hasValidBirdclawWebSession(request);
	const valid =
		(headerToken !== null && constantTimeEqual(headerToken, token)) ||
		(cookieValue !== null && constantTimeEqual(cookieValue, token)) ||
		sessionValid;
	return {
		configured: true,
		valid,
		fromCookie:
			((cookieValue !== null && constantTimeEqual(cookieValue, token)) ||
				sessionValid) &&
			!(headerToken !== null && constantTimeEqual(headerToken, token)),
		provided,
	};
}

function isLocalWebHost(value: string) {
	const host = normalizedHost(value);
	return LOCAL_HOSTS.has(host) || host.endsWith(".localhost");
}

function allowsUnauthenticatedLocalWeb(request: Request) {
	const mode = process.env.BIRDCLAW_LOCAL_WEB;
	if (mode === "socket") {
		return request.headers.get(LOCAL_WEB_PEER_HEADER) === "1";
	}
	return mode === "1";
}

function hasForwardedRequestHeaders(request: Request) {
	return (
		request.headers.has("forwarded") ||
		request.headers.has("x-forwarded-for") ||
		request.headers.has("x-forwarded-proto") ||
		request.headers.has("x-forwarded-host") ||
		request.headers.has("x-real-ip")
	);
}

function firstForwardedValue(value: string | null) {
	return value?.split(",")[0]?.trim() || null;
}

function forwardedHeaderPair(request: Request, key: "host" | "proto") {
	const forwarded = firstForwardedValue(request.headers.get("forwarded"));
	if (!forwarded) return null;
	for (const part of forwarded.split(";")) {
		const [name, ...rest] = part.trim().split("=");
		if (name?.toLowerCase() !== key) continue;
		const value = rest.join("=").trim().replace(/^"|"$/g, "");
		return value || null;
	}
	return null;
}

function forwardedOrigin(request: Request) {
	const proto =
		firstForwardedValue(request.headers.get("x-forwarded-proto")) ??
		forwardedHeaderPair(request, "proto");
	const host =
		firstForwardedValue(request.headers.get("x-forwarded-host")) ??
		forwardedHeaderPair(request, "host");
	if (!proto || !host) return null;
	const normalizedProto = proto.toLowerCase();
	if (normalizedProto !== "http" && normalizedProto !== "https") return null;
	return `${normalizedProto}://${host}`;
}

function sameRequestOrigin(request: Request, origin: string, url: URL) {
	return origin === url.origin || origin === forwardedOrigin(request);
}

export function sensitiveRequestErrorResponse(request: Request) {
	const url = new URL(request.url);
	const token = requestWebTokenStatus(request);
	const isLocalRequest =
		allowsUnauthenticatedLocalWeb(request) &&
		isLocalWebHost(url.hostname) &&
		!hasForwardedRequestHeaders(request);
	const fetchSite = request.headers.get("sec-fetch-site");
	const origin = request.headers.get("origin");
	const allowRemoteEnv = process.env.BIRDCLAW_ALLOW_REMOTE_WEB === "1";
	const allowTrustedRemote = allowRemoteEnv && !token.configured;

	if (isTestEnvironment() && !token.valid) return null;

	if (origin && !sameRequestOrigin(request, origin, url)) {
		return jsonResponse(
			{ ok: false, message: "Cross-origin web API access is disabled" },
			{ status: 403 },
		);
	}

	if (fetchSite === "cross-site") {
		return jsonResponse(
			{ ok: false, message: "Cross-site web API access is disabled" },
			{ status: 403 },
		);
	}

	if (
		!isTestEnvironment() &&
		!token.configured &&
		!isLocalRequest &&
		!allowTrustedRemote
	) {
		return jsonResponse(
			{
				ok: false,
				message:
					"Remote API access requires BIRDCLAW_ALLOW_REMOTE_WEB=1 for a trusted private proxy, or BIRDCLAW_WEB_TOKEN for tokened access",
			},
			{ status: 403 },
		);
	}

	if (token.configured && !token.valid && (token.provided || !isLocalRequest)) {
		return jsonResponse(
			{ ok: false, message: "Invalid web token" },
			{ status: 403 },
		);
	}

	const allowRemote = allowRemoteEnv && (token.valid || allowTrustedRemote);
	if (!allowRemote && !isLocalRequest) {
		return jsonResponse(
			{ ok: false, message: "Remote web API access is disabled" },
			{ status: 403 },
		);
	}

	if (
		token.fromCookie &&
		fetchSite !== "same-origin" &&
		fetchSite !== "same-site"
	) {
		return jsonResponse(
			{ ok: false, message: "Same-origin browser request required" },
			{ status: 403 },
		);
	}

	return null;
}

export function parseBoundedInteger(
	value: number | string | null | undefined,
	{
		defaultValue,
		min = 1,
		max,
	}: { defaultValue?: number; min?: number; max: number },
) {
	if (value === null || value === undefined || value === "")
		return defaultValue;
	if (typeof value === "string" && !/^\d+$/.test(value.trim())) {
		return defaultValue;
	}
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isSafeInteger(parsed)) return defaultValue;
	return Math.min(max, Math.max(min, parsed));
}
