// @vitest-environment node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startProductionServer } from "./production-server";

const tempDirs: string[] = [];
const originalLocalWeb = process.env.BIRDCLAW_LOCAL_WEB;

afterEach(() => {
	if (originalLocalWeb === undefined) delete process.env.BIRDCLAW_LOCAL_WEB;
	else process.env.BIRDCLAW_LOCAL_WEB = originalLocalWeb;
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("production server", () => {
	it("serves built assets before delegating requests to the SSR handler", async () => {
		const packageRoot = mkdtempSync(
			path.join(os.tmpdir(), "birdclaw-production-server-"),
		);
		tempDirs.push(packageRoot);
		const clientDir = path.join(packageRoot, "client");
		mkdirSync(path.join(clientDir, "assets"), { recursive: true });
		writeFileSync(path.join(clientDir, "assets", "app.js"), "built asset");
		const serverEntry = path.join(packageRoot, "server.mjs");
		writeFileSync(
			serverEntry,
			`export default { fetch(request) { return new Response("SSR " + new URL(request.url).pathname + " " + request.headers.get("x-birdclaw-local-peer"), { headers: { "content-type": "text/plain" } }); } };`,
		);

		const server = await startProductionServer({
			packageRoot,
			clientDir,
			serverEntry,
			port: 0,
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("no address");
		const baseUrl = `http://127.0.0.1:${String(address.port)}`;

		await expect(
			fetch(`${baseUrl}/route`, {
				headers: { "x-birdclaw-local-peer": "forged" },
			}).then((response) => response.text()),
		).resolves.toBe("SSR /route 1");
		const asset = await fetch(`${baseUrl}/assets/app.js`);
		expect(await asset.text()).toBe("built asset");
		expect(asset.headers.get("content-type")).toBe(
			"text/javascript; charset=utf-8",
		);
		expect(asset.headers.get("cache-control")).toContain("immutable");
		expect(process.env.BIRDCLAW_LOCAL_WEB).toBe("socket");

		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	});

	it("preserves byte ranges and partial streaming responses", async () => {
		const packageRoot = mkdtempSync(
			path.join(os.tmpdir(), "birdclaw-production-video-"),
		);
		tempDirs.push(packageRoot);
		const clientDir = path.join(packageRoot, "client");
		mkdirSync(clientDir, { recursive: true });
		const serverEntry = path.join(packageRoot, "server.mjs");
		writeFileSync(
			serverEntry,
			`export default { fetch(request) {
				const range = request.headers.get("range");
				return new Response(new Uint8Array([10, 11, 12, 13]), {
					status: 206,
					headers: {
						"accept-ranges": "bytes",
						"content-length": "4",
						"content-range": "bytes 10-13/100",
						"content-type": "video/mp4",
						"x-seen-range": range ?? ""
					}
				});
			} };`,
		);

		const server = await startProductionServer({
			packageRoot,
			clientDir,
			serverEntry,
			port: 0,
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("no address");
		const response = await fetch(
			`http://127.0.0.1:${String(address.port)}/api/tweet-video`,
			{ headers: { range: "bytes=10-13" } },
		);

		expect(response.status).toBe(206);
		expect(response.headers.get("x-seen-range")).toBe("bytes=10-13");
		expect(response.headers.get("content-range")).toBe("bytes 10-13/100");
		expect(response.headers.get("content-type")).toBe("video/mp4");
		expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([
			10, 11, 12, 13,
		]);

		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	});

	it("aborts the Web request and cancels its body when the client disconnects", async () => {
		const packageRoot = mkdtempSync(
			path.join(os.tmpdir(), "birdclaw-production-abort-"),
		);
		tempDirs.push(packageRoot);
		const clientDir = path.join(packageRoot, "client");
		mkdirSync(clientDir, { recursive: true });
		const serverEntry = path.join(packageRoot, "server.mjs");
		writeFileSync(
			serverEntry,
			`export default { fetch(request) {
				globalThis.__birdclawProductionAbort = { request: false, body: false };
				request.signal.addEventListener("abort", () => {
					globalThis.__birdclawProductionAbort.request = true;
				}, { once: true });
				return new Response(new ReadableStream({
					start(controller) {
						controller.enqueue(new Uint8Array([1, 2, 3]));
					},
					cancel() {
						globalThis.__birdclawProductionAbort.body = true;
					}
				}), { headers: { "content-type": "video/mp4" } });
			} };`,
		);

		const server = await startProductionServer({
			packageRoot,
			clientDir,
			serverEntry,
			port: 0,
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("no address");

		await new Promise<void>((resolve, reject) => {
			const request = http.get(
				`http://127.0.0.1:${String(address.port)}/api/tweet-video`,
				(response) => {
					response.once("data", () => {
						response.destroy();
						resolve();
					});
				},
			);
			request.once("error", reject);
		});

		await new Promise((resolve) => setTimeout(resolve, 25));
		const observed = (
			globalThis as typeof globalThis & {
				__birdclawProductionAbort?: { request: boolean; body: boolean };
			}
		).__birdclawProductionAbort;
		expect(observed).toEqual({ request: true, body: true });

		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
		delete (
			globalThis as typeof globalThis & {
				__birdclawProductionAbort?: { request: boolean; body: boolean };
			}
		).__birdclawProductionAbort;
	});
});
