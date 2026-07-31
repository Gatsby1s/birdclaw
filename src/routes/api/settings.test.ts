// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "#/lib/config";
import { getRouteHandler } from "#/test/route-handlers";
import { Route } from "./settings";

const GET = getRouteHandler(Route, "GET");
const POST = getRouteHandler(Route, "POST");
const tempRoots: string[] = [];

beforeEach(() => {
	const tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-settings-"));
	tempRoots.push(tempRoot);
	process.env.BIRDCLAW_HOME = tempRoot;
	resetBirdclawPathsForTests();
});

afterEach(() => {
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	delete process.env.BIRDCLAW_PROFILE_ANALYSIS_SOURCE;
	delete process.env.TWITTER_TOKEN;
	for (const tempRoot of tempRoots.splice(0)) {
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

describe("api settings route", () => {
	it("returns default settings", async () => {
		const response = await GET({
			request: new Request("http://localhost/api/settings"),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			analysis: { profileSource: "local" },
			providers: {
				twitter6551: {
					baseUrl: "https://ai.6551.io",
					tokenEnv: "TWITTER_TOKEN",
					tokenDetected: false,
				},
			},
		});
	});

	it("updates the profile analysis source", async () => {
		const response = await POST({
			request: new Request("http://localhost/api/settings", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ analysis: { profileSource: "xurl" } }),
			}),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			analysis: { profileSource: "xurl" },
		});
		const configPath = path.join(process.env.BIRDCLAW_HOME!, "config.json");
		expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
			analysis: { profileSource: "xurl" },
		});
	});

	it("stores the backup model token privately without returning it", async () => {
		const apiKey = "sk-test-deepseek-private";
		const response = await POST({
			request: new Request("http://localhost/api/settings", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					analysis: {
						summaryModels: { primary: "openai", backup: "deepseek" },
					},
					providers: { deepseek: { apiKey } },
				}),
			}),
		});

		expect(response.status).toBe(200);
		const payload = await response.json();
		expect(payload).toMatchObject({
			analysis: {
				summaryModels: { primary: "openai", backup: "deepseek" },
			},
			providers: { deepseek: { tokenConfigured: true } },
		});
		expect(JSON.stringify(payload)).not.toContain(apiKey);
		const configPath = path.join(process.env.BIRDCLAW_HOME!, "config.json");
		expect(statSync(configPath).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
			providers: { deepseek: { apiKey } },
		});
	});

	it("rejects unknown settings payloads", async () => {
		const response = await POST({
			request: new Request("http://localhost/api/settings", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ analysis: { profileSource: "bad" } }),
			}),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			ok: false,
			message: "Unknown settings payload",
		});
	});
});
