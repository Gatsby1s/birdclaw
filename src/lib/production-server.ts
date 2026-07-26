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
import { LOCAL_WEB_PEER_HEADER } from "./http-effect";

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

function isLoopbackAddress(address: string | undefined) {
	if (!address) return false;
	const normalized = address.toLowerCase().replace(/^::ffff:/, "");
	return normalized === "::1" || normalized.startsWith("127.");
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
	if (!fileStats?.isFile()) return false;

	target.statusCode = 200;
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
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, resolve);
	});
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
			server.close(() => process.kill(process.pid, signal));
			server.closeAllConnections();
		};
		for (const signal of signals) process.on(signal, stop);
		server.once("error", (error) => {
			removeHandlers();
			reject(error);
		});
	});
}
