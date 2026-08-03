import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import {
	clearBirdclawWebSessionCookie,
	createBirdclawWebSessionCookie,
	hasValidBirdclawWebSession,
	isBirdclawWebTokenConfigured,
	LOCAL_WEB_PEER_HEADER,
	verifyBirdclawWebToken,
} from "./http-effect";
import {
	getLocalCloudBridgeArchiveStats,
	importLocalCloudBridgeBatch,
	isLocalCloudBridgeTokenConfigured,
	startLocalCloudBridgeClient,
	stopLocalCloudBridgeClient,
	verifyLocalCloudBridgeToken,
} from "./local-cloud-bridge";
import {
	localAnalysisSubmissionSchema,
	startLocalAnalysisBridgeWorker,
	stopLocalAnalysisBridgeWorker,
	submitLocalAnalysisEvent,
	waitForLocalAnalysisClaim,
} from "./local-analysis-bridge";
import {
	startLocalTwitterCollector,
	stopLocalTwitterCollector,
} from "./local-twitter-collector";
import {
	startPeriodDigestScheduler,
	stopPeriodDigestScheduler,
} from "./period-digest-scheduler";
import {
	startWeeklyDigestScheduler,
	stopWeeklyDigestScheduler,
} from "./weekly-digest-scheduler";
import { handleRagMcpHttpRequest } from "./rag-mcp-server";
import {
	getTwitter6551RuntimeStatus,
	recordTwitter6551LocalHeartbeat,
	startTwitter6551WorkerManager,
	stopTwitter6551WorkerManager,
} from "./twitter-6551";

interface FetchHandler {
	fetch(request: Request): Response | Promise<Response>;
}

export interface ProductionServerOptions {
	packageRoot: string;
	host?: string;
	port?: number;
	clientDir?: string;
	serverEntry?: string;
}

const CONTENT_TYPES: Record<string, string> = {
	".css": "text/css; charset=utf-8",
	".gif": "image/gif",
	".html": "text/html; charset=utf-8",
	".ico": "image/x-icon",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".png": "image/png",
	".svg": "image/svg+xml",
	".txt": "text/plain; charset=utf-8",
	".webmanifest": "application/manifest+json",
	".woff": "font/woff",
	".woff2": "font/woff2",
};

const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_MAX_ATTEMPTS = 8;
const MAX_LOGIN_RATE_KEYS = 10_000;
const MAX_LOCAL_BRIDGE_BYTES = 8 * 1024 * 1024;

function isLoopbackAddress(address: string | undefined) {
	if (!address) return false;
	const normalized = address.toLowerCase().replace(/^::ffff:/, "");
	return normalized === "::1" || normalized.startsWith("127.");
}

function isLoopbackHost(host: string) {
	const normalized = host
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, "");
	return normalized === "localhost" || isLoopbackAddress(normalized);
}

function assertRemoteWebAuthentication(host: string) {
	const remoteAccessRequested =
		Boolean(process.env.RAILWAY_ENVIRONMENT) ||
		process.env.BIRDCLAW_ALLOW_REMOTE_WEB === "1" ||
		!isLoopbackHost(host);
	if (remoteAccessRequested && !isBirdclawWebTokenConfigured()) {
		throw new Error(
			"Refusing to start remote BirdClaw without BIRDCLAW_WEB_TOKEN",
		);
	}
}

function requestHeaders(request: IncomingMessage) {
	const headers = new Headers();
	for (const [name, value] of Object.entries(request.headers)) {
		if (Array.isArray(value)) {
			for (const item of value) headers.append(name, item);
		} else if (value !== undefined) {
			headers.set(name, value);
		}
	}
	// This header is adapter-owned. Never trust a value supplied by the client.
	headers.delete(LOCAL_WEB_PEER_HEADER);
	if (isLoopbackAddress(request.socket.remoteAddress)) {
		headers.set(LOCAL_WEB_PEER_HEADER, "1");
	}
	return headers;
}

function toWebRequest(request: IncomingMessage, signal: AbortSignal) {
	const host = request.headers.host ?? "127.0.0.1";
	const url = new URL(request.url ?? "/", `http://${host}`);
	const method = request.method ?? "GET";
	const init: RequestInit & { duplex?: "half" } = {
		method,
		headers: requestHeaders(request),
		signal,
	};
	if (method !== "GET" && method !== "HEAD") {
		init.body = Readable.toWeb(request) as ReadableStream;
		init.duplex = "half";
	}
	return new Request(url, init);
}

async function sendWebResponse(response: Response, target: ServerResponse) {
	target.statusCode = response.status;
	if (response.statusText) target.statusMessage = response.statusText;
	applySecurityHeaders(target);
	if (!response.headers.has("cache-control")) {
		target.setHeader("cache-control", "private, no-store");
	}
	const setCookies = response.headers.getSetCookie();
	for (const [name, value] of response.headers) {
		if (name !== "set-cookie") target.setHeader(name, value);
	}
	if (setCookies.length > 0) target.setHeader("set-cookie", setCookies);
	if (!response.body) {
		target.end();
		return;
	}
	await new Promise<void>((resolve, reject) => {
		const body = Readable.fromWeb(response.body as never);
		let settled = false;
		const cleanup = () => {
			body.off("error", fail);
			target.off("error", fail);
			target.off("finish", finish);
			target.off("close", close);
		};
		const settle = (callback: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			callback();
		};
		const fail = (error: Error) => settle(() => reject(error));
		const finish = () => settle(resolve);
		const close = () => {
			if (!target.writableFinished) body.destroy();
			settle(resolve);
		};
		body.once("error", fail);
		target.once("error", fail);
		target.once("finish", finish);
		target.once("close", close);
		body.pipe(target);
	});
}

function applySecurityHeaders(target: ServerResponse) {
	target.setHeader("x-content-type-options", "nosniff");
	target.setHeader("x-frame-options", "DENY");
	target.setHeader("referrer-policy", "same-origin");
	target.setHeader(
		"permissions-policy",
		"camera=(), microphone=(), geolocation=()",
	);
	target.setHeader(
		"content-security-policy",
		"default-src 'self'; img-src 'self' data: https:; media-src 'self' https: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; worker-src 'self' blob:; connect-src 'self' https: wss:",
	);
}

function sendText(
	target: ServerResponse,
	status: number,
	body: string,
	contentType = "text/plain; charset=utf-8",
	headers: Record<string, string> = {},
) {
	target.statusCode = status;
	target.setHeader("content-type", contentType);
	target.setHeader("cache-control", "private, no-store");
	applySecurityHeaders(target);
	for (const [name, value] of Object.entries(headers)) {
		target.setHeader(name, value);
	}
	target.end(body);
}

function requestUsesHttps(request: IncomingMessage) {
	const forwarded = request.headers["x-forwarded-proto"];
	const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
	return value?.split(",")[0]?.trim().toLowerCase() === "https";
}

function requestNeedsLogin(request: IncomingMessage) {
	if (!isBirdclawWebTokenConfigured()) return false;
	if (hasForwardingHeaders(request)) return true;
	return !isLoopbackAddress(request.socket.remoteAddress);
}

function hasForwardingHeaders(request: IncomingMessage) {
	return Boolean(
		request.headers.forwarded ||
		request.headers["x-forwarded-for"] ||
		request.headers["x-forwarded-proto"] ||
		request.headers["x-forwarded-host"],
	);
}

function safeNextPath(value: string | null) {
	return value?.startsWith("/") && !value.startsWith("//") ? value : "/";
}

function decodedNextPath(value: string | null) {
	try {
		return safeNextPath(decodeURIComponent(value ?? "/"));
	} catch {
		return "/";
	}
}

function loginHtml({ next, error }: { next: string; error?: string }) {
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>登录 BirdClaw</title>
<style>
:root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;background:#0b0f14;color:#e7edf3}
main{width:min(100%,420px);border:1px solid #2c3844;border-radius:22px;padding:28px;background:#111820;box-shadow:0 18px 55px #0006}
h1{margin:0;font-size:25px}p{color:#9aa8b5;line-height:1.55}.error{color:#ff8b96}
label{display:block;margin:22px 0 8px;font-size:14px;font-weight:700}
input,button{width:100%;min-height:48px;border-radius:14px;font:inherit}
input{border:1px solid #465665;background:#0b0f14;color:#fff;padding:0 14px}
button{margin-top:14px;border:0;background:#1d9bf0;color:#fff;font-weight:800;cursor:pointer}
small{display:block;margin-top:16px;color:#71808e}
</style>
</head>
<body><main>
<h1>BirdClaw</h1>
<p>这是皇上的私人云端推文资料库。</p>
${error ? `<p class="error">${error}</p>` : ""}
<form method="post" action="/login">
<input type="hidden" name="next" value="${encodeURIComponent(next)}">
<label for="token">访问口令</label>
<input id="token" name="token" type="password" autocomplete="current-password" required autofocus>
<button type="submit">进入 BirdClaw</button>
</form>
<small>登录状态会安全保存在本设备 30 天。</small>
</main></body></html>`;
}

async function readSmallForm(request: IncomingMessage) {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > 16_384) throw new Error("Login request is too large");
		chunks.push(buffer);
	}
	return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

async function readLocalBridgeJson(request: IncomingMessage) {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > MAX_LOCAL_BRIDGE_BYTES) {
			throw new Error("Local bridge request is too large");
		}
		chunks.push(buffer);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

async function handleLocalCloudBridge(
	request: IncomingMessage,
	response: ServerResponse,
) {
	const url = new URL(request.url ?? "/", "http://local");
	if (url.pathname !== "/api/integrations/local-bridge") return false;
	if (request.method !== "GET" && request.method !== "POST") {
		sendText(response, 405, "Method not allowed", "text/plain; charset=utf-8", {
			allow: "GET, POST",
		});
		return true;
	}
	if (!isLocalCloudBridgeTokenConfigured()) {
		sendText(response, 503, "Local bridge is not configured");
		return true;
	}
	const authorization = request.headers.authorization;
	const candidate = authorization?.startsWith("Bearer ")
		? authorization.slice("Bearer ".length).trim()
		: "";
	if (!verifyLocalCloudBridgeToken(candidate)) {
		sendText(response, 401, "Unauthorized");
		return true;
	}
	if (request.method === "GET") {
		sendText(
			response,
			200,
			JSON.stringify({ ok: true, counts: getLocalCloudBridgeArchiveStats() }),
			"application/json; charset=utf-8",
		);
		return true;
	}
	try {
		const result = await importLocalCloudBridgeBatch(
			await readLocalBridgeJson(request),
		);
		if (result.purpose === "live" && result.caughtUp) {
			await recordTwitter6551LocalHeartbeat(result.edges);
		}
		sendText(
			response,
			200,
			JSON.stringify(result),
			"application/json; charset=utf-8",
		);
	} catch (error) {
		sendText(
			response,
			400,
			JSON.stringify({
				ok: false,
				message: error instanceof Error ? error.message : String(error),
			}),
			"application/json; charset=utf-8",
		);
	}
	return true;
}

async function handleLocalAnalysisBridge(
	request: IncomingMessage,
	response: ServerResponse,
	signal: AbortSignal,
) {
	const url = new URL(request.url ?? "/", "http://local");
	if (url.pathname !== "/api/integrations/local-analysis") return false;
	if (request.method !== "GET" && request.method !== "POST") {
		sendText(response, 405, "Method not allowed", "text/plain; charset=utf-8", {
			allow: "GET, POST",
		});
		return true;
	}
	if (!isLocalCloudBridgeTokenConfigured()) {
		sendText(response, 503, "Local analysis bridge is not configured");
		return true;
	}
	const authorization = request.headers.authorization;
	const candidate = authorization?.startsWith("Bearer ")
		? authorization.slice("Bearer ".length).trim()
		: "";
	if (!verifyLocalCloudBridgeToken(candidate)) {
		sendText(response, 401, "Unauthorized");
		return true;
	}
	try {
		const result =
			request.method === "GET"
				? {
						ok: true as const,
						job: await waitForLocalAnalysisClaim({ signal }),
					}
				: {
						...submitLocalAnalysisEvent(
							localAnalysisSubmissionSchema.parse(
								await readLocalBridgeJson(request),
							),
						),
					};
		sendText(
			response,
			200,
			JSON.stringify(result),
			"application/json; charset=utf-8",
		);
	} catch (error) {
		sendText(
			response,
			400,
			JSON.stringify({
				ok: false,
				message: error instanceof Error ? error.message : String(error),
			}),
			"application/json; charset=utf-8",
		);
	}
	return true;
}

function loginRateKey(request: IncomingMessage) {
	const realIp = request.headers["x-real-ip"];
	const realIpValue = Array.isArray(realIp) ? realIp.at(-1) : realIp;
	if (realIpValue?.trim()) return realIpValue.trim();
	const forwarded = request.headers["x-forwarded-for"];
	const value = Array.isArray(forwarded) ? forwarded.at(-1) : forwarded;
	return (
		value?.split(",").at(-1)?.trim() ||
		request.socket.remoteAddress ||
		"unknown"
	);
}

function loginRateLimited(request: IncomingMessage) {
	const key = loginRateKey(request);
	const now = Date.now();
	if (loginAttempts.size >= MAX_LOGIN_RATE_KEYS) {
		for (const [candidate, attempt] of loginAttempts) {
			if (attempt.resetAt <= now) loginAttempts.delete(candidate);
		}
		if (loginAttempts.size >= MAX_LOGIN_RATE_KEYS) {
			const oldest = loginAttempts.keys().next().value as string | undefined;
			if (oldest) loginAttempts.delete(oldest);
		}
	}
	const current = loginAttempts.get(key);
	if (!current || current.resetAt <= now) {
		loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
		return false;
	}
	current.count += 1;
	return current.count > LOGIN_MAX_ATTEMPTS;
}

function loginOriginAllowed(request: IncomingMessage) {
	const origin = request.headers.origin;
	if (!origin) return true;
	const host =
		(Array.isArray(request.headers["x-forwarded-host"])
			? request.headers["x-forwarded-host"][0]
			: request.headers["x-forwarded-host"]) ?? request.headers.host;
	const protocol = requestUsesHttps(request) ? "https" : "http";
	return Boolean(host && origin === `${protocol}://${host}`);
}

async function handlePrivateWebGate(
	request: IncomingMessage,
	response: ServerResponse,
) {
	const url = new URL(request.url ?? "/", "http://local");
	if (url.pathname === "/healthz") {
		const worker = getTwitter6551RuntimeStatus();
		sendText(
			response,
			200,
			JSON.stringify({
				ok: true,
				worker: worker.enabled ? worker.state : "disabled",
			}),
			"application/json; charset=utf-8",
		);
		return true;
	}
	if (!requestNeedsLogin(request)) return false;
	const webRequest = toWebRequest(request, new AbortController().signal);
	const signedIn = hasValidBirdclawWebSession(webRequest);
	if (url.pathname === "/logout") {
		sendText(response, 303, "", "text/plain; charset=utf-8", {
			location: "/login",
			"set-cookie": clearBirdclawWebSessionCookie({
				secure: requestUsesHttps(request),
			}),
		});
		return true;
	}
	if (url.pathname === "/login" && request.method === "GET") {
		if (signedIn) {
			sendText(response, 303, "", "text/plain; charset=utf-8", {
				location: safeNextPath(url.searchParams.get("next")),
			});
		} else {
			sendText(
				response,
				200,
				loginHtml({ next: safeNextPath(url.searchParams.get("next")) }),
				"text/html; charset=utf-8",
			);
		}
		return true;
	}
	if (url.pathname === "/login" && request.method === "POST") {
		if (!loginOriginAllowed(request)) {
			sendText(response, 403, "Cross-origin login is disabled");
			return true;
		}
		if (loginRateLimited(request)) {
			sendText(
				response,
				429,
				loginHtml({
					next: "/",
					error: "尝试次数过多，请稍后再试。",
				}),
				"text/html; charset=utf-8",
			);
			return true;
		}
		const form = await readSmallForm(request);
		const next = decodedNextPath(form.get("next"));
		if (!verifyBirdclawWebToken(form.get("token") ?? "")) {
			sendText(
				response,
				401,
				loginHtml({ next, error: "口令不正确。" }),
				"text/html; charset=utf-8",
			);
			return true;
		}
		loginAttempts.delete(loginRateKey(request));
		sendText(response, 303, "", "text/plain; charset=utf-8", {
			location: next,
			"set-cookie": createBirdclawWebSessionCookie({
				secure: requestUsesHttps(request),
			}),
		});
		return true;
	}
	if (
		url.pathname.startsWith("/assets/") ||
		url.pathname === "/favicon.ico" ||
		url.pathname === "/birdclaw-live-version.json"
	) {
		return false;
	}
	if (!signedIn) {
		if (url.pathname.startsWith("/api/")) {
			sendText(
				response,
				401,
				JSON.stringify({ ok: false, message: "Authentication required" }),
				"application/json; charset=utf-8",
			);
		} else {
			sendText(response, 303, "", "text/plain; charset=utf-8", {
				location: `/login?next=${encodeURIComponent(
					safeNextPath(url.pathname + url.search),
				)}`,
			});
		}
		return true;
	}
	return false;
}

async function sendStaticFile(
	request: IncomingMessage,
	target: ServerResponse,
	clientDir: string,
) {
	if (request.method !== "GET" && request.method !== "HEAD") return false;
	let pathname: string;
	try {
		pathname = decodeURIComponent(
			new URL(request.url ?? "/", "http://local").pathname,
		);
	} catch {
		target.writeHead(400).end("Bad request");
		return true;
	}
	const root = path.resolve(clientDir);
	const filePath = path.resolve(root, `.${pathname}`);
	if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
		target.writeHead(403).end("Forbidden");
		return true;
	}
	const fileStats = await stat(filePath).catch(() => undefined);
	if (!fileStats?.isFile()) {
		const railwayCommit = process.env.RAILWAY_GIT_COMMIT_SHA?.trim();
		if (pathname !== "/birdclaw-live-version.json" || !railwayCommit) {
			return false;
		}
		const body = `${JSON.stringify({ commit: railwayCommit })}\n`;
		target.statusCode = 200;
		applySecurityHeaders(target);
		target.setHeader("cache-control", "private, no-store");
		target.setHeader("content-length", String(Buffer.byteLength(body)));
		target.setHeader("content-type", "application/json; charset=utf-8");
		target.end(request.method === "HEAD" ? undefined : body);
		return true;
	}

	target.statusCode = 200;
	applySecurityHeaders(target);
	target.setHeader("content-length", String(fileStats.size));
	target.setHeader(
		"content-type",
		CONTENT_TYPES[path.extname(filePath).toLowerCase()] ??
			"application/octet-stream",
	);
	if (pathname.startsWith("/assets/")) {
		target.setHeader("cache-control", "public, max-age=31536000, immutable");
	}
	if (request.method === "HEAD") {
		target.end();
		return true;
	}
	await new Promise<void>((resolve, reject) => {
		const stream = createReadStream(filePath);
		stream.once("error", reject);
		target.once("error", reject);
		target.once("finish", resolve);
		stream.pipe(target);
	});
	return true;
}

export async function startProductionServer({
	packageRoot,
	host = "127.0.0.1",
	port = 3000,
	clientDir = path.join(packageRoot, "dist", "client"),
	serverEntry = path.join(packageRoot, "dist", "server", "server.js"),
}: ProductionServerOptions) {
	assertRemoteWebAuthentication(host);
	process.env.BIRDCLAW_LOCAL_WEB = "socket";
	const loaded = (await import(pathToFileURL(serverEntry).href)) as {
		default?: FetchHandler;
	};
	if (!loaded.default || typeof loaded.default.fetch !== "function") {
		throw new Error(
			`Production server entry has no fetch handler: ${serverEntry}`,
		);
	}
	const handler = loaded.default;
	const server = createServer(async (request, response) => {
		const requestAbort = new AbortController();
		const abortRequest = () => requestAbort.abort();
		const abortClosedResponse = () => {
			if (!response.writableFinished) abortRequest();
		};
		request.once("aborted", abortRequest);
		response.once("close", abortClosedResponse);
		try {
			if (await handleRagMcpHttpRequest(request, response)) return;
			if (
				await handleLocalAnalysisBridge(request, response, requestAbort.signal)
			)
				return;
			if (await handleLocalCloudBridge(request, response)) return;
			if (await handlePrivateWebGate(request, response)) return;
			if (await sendStaticFile(request, response, clientDir)) return;
			await sendWebResponse(
				await handler.fetch(toWebRequest(request, requestAbort.signal)),
				response,
			);
		} catch (error) {
			if (!response.headersSent) {
				response.statusCode = 500;
				response.setHeader("content-type", "text/plain; charset=utf-8");
			}
			response.end("Internal server error");
			console.error(error instanceof Error ? error.message : String(error));
		} finally {
			request.off("aborted", abortRequest);
			response.off("close", abortClosedResponse);
		}
	});
	server.once("close", () => {
		stopPeriodDigestScheduler();
		stopWeeklyDigestScheduler();
		stopLocalCloudBridgeClient();
		stopLocalAnalysisBridgeWorker();
		stopLocalTwitterCollector();
		void stopTwitter6551WorkerManager();
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, resolve);
	});
	try {
		startPeriodDigestScheduler();
		startWeeklyDigestScheduler();
		startLocalTwitterCollector();
		startLocalCloudBridgeClient();
		startLocalAnalysisBridgeWorker();
		void startTwitter6551WorkerManager().catch((error) => {
			console.error(
				`6551 worker startup failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
	} catch (error) {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		throw error;
	}
	return server;
}

export async function runProductionServer(options: ProductionServerOptions) {
	const server = await startProductionServer(options);
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Production server did not bind a TCP address");
	}
	console.log(
		`Birdclaw listening on http://${options.host ?? "127.0.0.1"}:${String(address.port)}`,
	);

	await new Promise<never>((_, reject) => {
		const signals = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const;
		const removeHandlers = () => {
			for (const signal of signals) process.removeListener(signal, stop);
		};
		const stop = (signal: NodeJS.Signals) => {
			removeHandlers();
			stopPeriodDigestScheduler();
			stopWeeklyDigestScheduler();
			stopLocalCloudBridgeClient();
			stopLocalAnalysisBridgeWorker();
			stopLocalTwitterCollector();
			void stopTwitter6551WorkerManager().finally(() => {
				server.close(() => process.kill(process.pid, signal));
				server.closeAllConnections();
			});
		};
		for (const signal of signals) process.on(signal, stop);
		server.once("error", (error) => {
			removeHandlers();
			reject(error);
		});
	});
}
