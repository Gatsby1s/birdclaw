// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "#/lib/config";
import { resetDatabaseForTests } from "#/lib/db";
import {
	createXRemarkPairing,
	XREMARK_EXTENSION_ORIGIN,
} from "#/lib/xremark-live";
import { Route } from "./integrations.xremark.snapshot";

type Handler = (context: { request: Request }) => Response | Promise<Response>;

function handler(method: "OPTIONS" | "POST") {
	const handlers = Route.options.server?.handlers as unknown as Record<
		"OPTIONS" | "POST",
		Handler
	>;
	return handlers[method];
}

function snapshot(sequence: number, remarks: Array<Record<string, unknown>>) {
	return {
		sourceId: "source_route_1",
		sequence,
		capturedAt: 1_752_499_800_000 + sequence,
		database: {
			name: "xRemark",
			version: 1,
			backupID: `route_${String(sequence)}`,
			backupTime: 1_752_499_800_000 + sequence,
		},
		remarks,
		tags: [],
		categories: [],
	};
}

function request(
	token: string,
	body: unknown,
	options: { origin?: string; url?: string; forwarded?: boolean } = {},
) {
	const headers: Record<string, string> = {
		origin: options.origin ?? XREMARK_EXTENSION_ORIGIN,
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
	};
	if (options.forwarded) headers["x-forwarded-for"] = "127.0.0.1";
	return new Request(
		options.url ?? "http://127.0.0.1:3001/api/integrations/xremark/snapshot",
		{ method: "POST", headers, body: JSON.stringify(body) },
	);
}

let tempDir = "";

beforeEach(() => {
	tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-xremark-live-route-"));
	process.env.BIRDCLAW_HOME = tempDir;
	resetBirdclawPathsForTests();
});

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	rmSync(tempDir, { recursive: true, force: true });
});

describe("X Remark live snapshot API", () => {
	it("accepts exact-origin CORS preflight", async () => {
		const response = await handler("OPTIONS")({
			request: new Request(
				"http://127.0.0.1:3001/api/integrations/xremark/snapshot",
				{ method: "OPTIONS", headers: { origin: XREMARK_EXTENSION_ORIGIN } },
			),
		});
		expect(response.status).toBe(204);
		expect(response.headers.get("access-control-allow-origin")).toBe(
			XREMARK_EXTENSION_ORIGIN,
		);
	});

	it("imports ordered full snapshots and synchronizes deletions", async () => {
		const { token } = createXRemarkPairing();
		const first = await handler("POST")({
			request: request(
				token,
				snapshot(1, [
					{ identifier: "42", additionalName: "ada", remark: "Investor" },
				]),
			),
		});
		expect(first.status).toBe(200);
		expect(await first.json()).toMatchObject({
			ok: true,
			live: { connected: true, lastSequence: 1 },
			xRemark: { annotationCount: 1 },
		});

		const deleted = await handler("POST")({
			request: request(token, snapshot(2, [])),
		});
		expect(await deleted.json()).toMatchObject({
			ok: true,
			xRemark: { annotationCount: 0 },
		});
	});

	it("rejects wrong origins, forwarded requests, invalid tokens, and stale data", async () => {
		const { token } = createXRemarkPairing();
		expect(
			(
				await handler("POST")({
					request: request(token, snapshot(1, []), {
						origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
					}),
				})
			).status,
		).toBe(403);
		expect(
			(
				await handler("POST")({
					request: request(token, snapshot(1, []), { forwarded: true }),
				})
			).status,
		).toBe(403);
		expect(
			(
				await handler("POST")({
					request: request(`${token}x`, snapshot(1, [])),
				})
			).status,
		).toBe(401);

		await handler("POST")({ request: request(token, snapshot(2, [])) });
		const stale = await handler("POST")({
			request: request(token, snapshot(1, [])),
		});
		expect(stale.status).toBe(409);
		expect(await stale.json()).toMatchObject({ code: "stale-sequence" });
	});
});
