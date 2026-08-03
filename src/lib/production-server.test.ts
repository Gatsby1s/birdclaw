// @vitest-environment node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	insertTestAccount,
	insertTestProfile,
	insertTestTweet,
	withTestHome,
} from "../test/test-home";
import { startProductionServer } from "./production-server";
import {
	__test__ as localAnalysisBridgeTest,
	streamLocalAnalysisJob,
} from "./local-analysis-bridge";
import { getTwitter6551RuntimeStatus } from "./twitter-6551";

const schedulerMocks = vi.hoisted(() => ({
	startDaily: vi.fn(),
	stopDaily: vi.fn(),
	startWeekly: vi.fn(),
	stopWeekly: vi.fn(),
}));

vi.mock("./period-digest-scheduler", () => ({
	startPeriodDigestScheduler: schedulerMocks.startDaily,
	stopPeriodDigestScheduler: schedulerMocks.stopDaily,
}));

vi.mock("./weekly-digest-scheduler", () => ({
	startWeeklyDigestScheduler: schedulerMocks.startWeekly,
	stopWeeklyDigestScheduler: schedulerMocks.stopWeekly,
}));

const tempDirs: string[] = [];
const originalLocalWeb = process.env.BIRDCLAW_LOCAL_WEB;
const originalWebToken = process.env.BIRDCLAW_WEB_TOKEN;
const originalAllowRemoteWeb = process.env.BIRDCLAW_ALLOW_REMOTE_WEB;
const originalRailwayGitCommitSha = process.env.RAILWAY_GIT_COMMIT_SHA;

afterEach(() => {
	if (originalLocalWeb === undefined) delete process.env.BIRDCLAW_LOCAL_WEB;
	else process.env.BIRDCLAW_LOCAL_WEB = originalLocalWeb;
	if (originalWebToken === undefined) delete process.env.BIRDCLAW_WEB_TOKEN;
	else process.env.BIRDCLAW_WEB_TOKEN = originalWebToken;
	if (originalAllowRemoteWeb === undefined)
		delete process.env.BIRDCLAW_ALLOW_REMOTE_WEB;
	else process.env.BIRDCLAW_ALLOW_REMOTE_WEB = originalAllowRemoteWeb;
	if (originalRailwayGitCommitSha === undefined)
		delete process.env.RAILWAY_GIT_COMMIT_SHA;
	else process.env.RAILWAY_GIT_COMMIT_SHA = originalRailwayGitCommitSha;
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
	vi.clearAllMocks();
	localAnalysisBridgeTest.resetStore();
});

describe("production server", () => {
	it("serves the Railway deployment commit as a public live version manifest", async () => {
		process.env.BIRDCLAW_WEB_TOKEN = "correct horse battery staple";
		process.env.BIRDCLAW_ALLOW_REMOTE_WEB = "1";
		process.env.RAILWAY_GIT_COMMIT_SHA =
			"0123456789abcdef0123456789abcdef01234567";
		const packageRoot = mkdtempSync(
			path.join(os.tmpdir(), "birdclaw-production-version-"),
		);
		tempDirs.push(packageRoot);
		const clientDir = path.join(packageRoot, "client");
		mkdirSync(clientDir, { recursive: true });
		const serverEntry = path.join(packageRoot, "server.mjs");
		writeFileSync(
			serverEntry,
			`export default { fetch() { return new Response("SSR fallback", { status: 404 }); } };`,
		);
		const server = await startProductionServer({
			packageRoot,
			clientDir,
			serverEntry,
			port: 0,
		});
		expect(schedulerMocks.startDaily).toHaveBeenCalledTimes(1);
		expect(schedulerMocks.startWeekly).toHaveBeenCalledTimes(1);
		try {
			const address = server.address();
			if (!address || typeof address === "string") {
				throw new Error("no address");
			}
			const url = `http://127.0.0.1:${String(address.port)}/birdclaw-live-version.json`;
			const headers = {
				"x-forwarded-for": "203.0.113.8",
				"x-forwarded-host": "birdclaw.example",
				"x-forwarded-proto": "https",
			};
			const response = await fetch(url, { headers });
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toBe(
				"application/json; charset=utf-8",
			);
			expect(response.headers.get("cache-control")).toBe("private, no-store");
			await expect(response.json()).resolves.toEqual({
				commit: "0123456789abcdef0123456789abcdef01234567",
			});

			const head = await fetch(url, { method: "HEAD", headers });
			expect(head.status).toBe(200);
			expect(await head.text()).toBe("");
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		expect(schedulerMocks.stopDaily).toHaveBeenCalledTimes(1);
		expect(schedulerMocks.stopWeekly).toHaveBeenCalledTimes(1);
	});

	it("protects remote pages with the signed mobile login flow", async () => {
		process.env.BIRDCLAW_WEB_TOKEN = "correct horse battery staple";
		process.env.BIRDCLAW_ALLOW_REMOTE_WEB = "1";
		const packageRoot = mkdtempSync(
			path.join(os.tmpdir(), "birdclaw-production-login-"),
		);
		tempDirs.push(packageRoot);
		const clientDir = path.join(packageRoot, "client");
		mkdirSync(clientDir, { recursive: true });
		const serverEntry = path.join(packageRoot, "server.mjs");
		writeFileSync(
			serverEntry,
			`export default { fetch(request) { return new Response("private " + new URL(request.url).pathname); } };`,
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
		const proxyHeaders = {
			"x-forwarded-for": "203.0.113.8",
			"x-forwarded-host": "birdclaw.example",
			"x-forwarded-proto": "https",
		};

		const denied = await fetch(`${baseUrl}/private`, {
			headers: proxyHeaders,
			redirect: "manual",
		});
		expect(denied.status).toBe(303);
		expect(denied.headers.get("location")).toContain("/login?next=");

		const login = await fetch(`${baseUrl}/login`, {
			headers: proxyHeaders,
		});
		expect(login.status).toBe(200);
		expect(await login.text()).toContain("访问口令");

		const accepted = await fetch(`${baseUrl}/login`, {
			method: "POST",
			headers: {
				...proxyHeaders,
				"content-type": "application/x-www-form-urlencoded",
				origin: "https://birdclaw.example",
			},
			body: new URLSearchParams({
				token: "correct horse battery staple",
				next: encodeURIComponent("/private"),
			}),
			redirect: "manual",
		});
		expect(accepted.status).toBe(303);
		expect(accepted.headers.get("location")).toBe("/private");
		const cookie = accepted.headers.get("set-cookie");
		expect(cookie).toContain("birdclaw_session=");
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("Secure");

		const privatePage = await fetch(`${baseUrl}/private`, {
			headers: {
				...proxyHeaders,
				cookie: cookie?.split(";")[0] ?? "",
			},
		});
		expect(await privatePage.text()).toBe("private /private");

		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	});

	it("refuses public binding when the web token is missing", async () => {
		delete process.env.BIRDCLAW_WEB_TOKEN;
		process.env.BIRDCLAW_ALLOW_REMOTE_WEB = "1";
		const packageRoot = mkdtempSync(
			path.join(os.tmpdir(), "birdclaw-production-no-token-"),
		);
		tempDirs.push(packageRoot);
		const clientDir = path.join(packageRoot, "client");
		mkdirSync(clientDir, { recursive: true });
		const serverEntry = path.join(packageRoot, "server.mjs");
		writeFileSync(
			serverEntry,
			`export default { fetch() { return new Response("private"); } };`,
		);

		await expect(
			startProductionServer({
				packageRoot,
				clientDir,
				serverEntry,
				host: "0.0.0.0",
				port: 0,
			}),
		).rejects.toThrow("BIRDCLAW_WEB_TOKEN");
	});

	it("requires the dedicated token on the local bridge endpoint", async () => {
		await withTestHome(async (home) => {
			process.env.BIRDCLAW_LOCAL_BRIDGE_TOKEN = "bridge-secret";
			insertTestAccount(home.db);
			insertTestProfile(home.db);
			insertTestTweet(home.db);
			home.db
				.prepare(
					`
					insert into tweet_account_edges (
						account_id, tweet_id, kind, first_seen_at, last_seen_at,
						seen_count, source, raw_json, updated_at
					) values (?, ?, 'home', ?, ?, 1, 'bird', '{}', ?)
					`,
				)
				.run(
					"account:test",
					"tweet:test",
					"2026-07-31T08:00:00.000Z",
					"2026-07-31T08:00:00.000Z",
					"2026-07-31T08:00:00.000Z",
				);
			const packageRoot = mkdtempSync(
				path.join(os.tmpdir(), "birdclaw-production-bridge-"),
			);
			tempDirs.push(packageRoot);
			const clientDir = path.join(packageRoot, "client");
			mkdirSync(clientDir, { recursive: true });
			const serverEntry = path.join(packageRoot, "server.mjs");
			writeFileSync(
				serverEntry,
				`export default { fetch() { return new Response("private"); } };`,
			);
			const server = await startProductionServer({
				packageRoot,
				clientDir,
				serverEntry,
				port: 0,
			});
			try {
				const address = server.address();
				if (!address || typeof address === "string") {
					throw new Error("no address");
				}
				const url = `http://127.0.0.1:${String(address.port)}/api/integrations/local-bridge`;
				const batch = {
					version: 1,
					sentAt: "2026-07-31T08:00:00.000Z",
					caughtUp: true,
					cursor: {
						updatedAt: "2026-07-31T08:00:00.000Z",
						accountId: "",
						tweetId: "",
						kind: "",
					},
					accounts: [],
					profiles: [],
					tweets: [],
					edges: [],
				};

				await expect(
					fetch(url, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(batch),
					}).then((response) => response.status),
				).resolves.toBe(401);
				await expect(
					fetch(url).then((response) => response.status),
				).resolves.toBe(401);
				const stats = await fetch(url, {
					headers: { authorization: "Bearer bridge-secret" },
				});
				expect(stats.status).toBe(200);
				await expect(stats.json()).resolves.toEqual({
					ok: true,
					counts: {
						accounts: 1,
						profiles: 1,
						tweets: 1,
						edges: 1,
						homeEdges: 1,
						homeTweets: 1,
					},
				});
				const accepted = await fetch(url, {
					method: "POST",
					headers: {
						authorization: "Bearer bridge-secret",
						"content-type": "application/json",
					},
					body: JSON.stringify(batch),
				});
				expect(accepted.status).toBe(200);
				await expect(accepted.json()).resolves.toMatchObject({
					ok: true,
					purpose: "live",
					caughtUp: true,
					edges: 0,
				});
				const heartbeatAfterLive = getTwitter6551RuntimeStatus();
				const historyAccepted = await fetch(url, {
					method: "POST",
					headers: {
						authorization: "Bearer bridge-secret",
						"content-type": "application/json",
					},
					body: JSON.stringify({ ...batch, purpose: "history" }),
				});
				expect(historyAccepted.status).toBe(200);
				await expect(historyAccepted.json()).resolves.toMatchObject({
					ok: true,
					purpose: "history",
					caughtUp: true,
				});
				expect(getTwitter6551RuntimeStatus()).toMatchObject({
					lastLocalHeartbeatAt: heartbeatAfterLive.lastLocalHeartbeatAt,
					localBridgeIngestedCount: heartbeatAfterLive.localBridgeIngestedCount,
				});
			} finally {
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
		});
	});

	it("lets the authenticated Mac worker claim and complete a cloud analysis job", async () => {
		await withTestHome(async () => {
			process.env.BIRDCLAW_LOCAL_BRIDGE_TOKEN = "bridge-secret";
			const packageRoot = mkdtempSync(
				path.join(os.tmpdir(), "birdclaw-production-analysis-bridge-"),
			);
			tempDirs.push(packageRoot);
			const clientDir = path.join(packageRoot, "client");
			mkdirSync(clientDir, { recursive: true });
			const serverEntry = path.join(packageRoot, "server.mjs");
			writeFileSync(
				serverEntry,
				`export default { fetch() { return new Response("private"); } };`,
			);
			const server = await startProductionServer({
				packageRoot,
				clientDir,
				serverEntry,
				port: 0,
			});
			try {
				const address = server.address();
				if (!address || typeof address === "string") {
					throw new Error("no address");
				}
				const url = `http://127.0.0.1:${String(address.port)}/api/integrations/local-analysis`;
				await expect(
					fetch(url).then((response) => response.status),
				).resolves.toBe(401);
				const resultPromise = streamLocalAnalysisJob(
					{
						kind: "profile-analysis",
						body: {
							input: [
								{ role: "system", content: "Analyze." },
								{ role: "user", content: "Context." },
							],
							stream: true,
						},
					},
					{ claimTimeoutMs: 1_000 },
				);
				const claimResponse = await fetch(url, {
					headers: { authorization: "Bearer bridge-secret" },
				});
				expect(claimResponse.status).toBe(200);
				const claimPayload = (await claimResponse.json()) as {
					ok: boolean;
					job: { id: string; leaseToken: string };
				};
				expect(claimPayload.ok).toBe(true);
				const accepted = await fetch(url, {
					method: "POST",
					headers: {
						authorization: "Bearer bridge-secret",
						"content-type": "application/json",
					},
					body: JSON.stringify({
						type: "done",
						jobId: claimPayload.job.id,
						leaseToken: claimPayload.job.leaseToken,
						sequence: 1,
						rawText: "GPT result",
						model: "gpt-5.5",
					}),
				});
				expect(accepted.status).toBe(200);
				await expect(accepted.json()).resolves.toMatchObject({ ok: true });
				await expect(resultPromise).resolves.toEqual({
					rawText: "GPT result",
					model: "gpt-5.5",
				});
			} finally {
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
		});
	});

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
