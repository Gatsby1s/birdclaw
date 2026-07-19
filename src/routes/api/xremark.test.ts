// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "#/lib/config";
import { resetDatabaseForTests } from "#/lib/db";
import { Route } from "./xremark";

type XRemarkMethod = "GET" | "POST";
type XRemarkHandler = (context: {
	request: Request;
}) => Response | Promise<Response>;

function routeHandler(method: XRemarkMethod) {
	const handlers = Route.options.server?.handlers as unknown as Record<
		XRemarkMethod,
		XRemarkHandler
	>;
	return handlers[method];
}

const GET = routeHandler("GET");
const POST = routeHandler("POST");
let tempDir = "";

beforeEach(() => {
	tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-xremark-route-"));
	process.env.BIRDCLAW_HOME = tempDir;
	resetBirdclawPathsForTests();
});

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	rmSync(tempDir, { recursive: true, force: true });
});

describe("api X Remark route", () => {
	it("imports a valid X Remark backup and reports its status", async () => {
		const response = await POST({
			request: new Request("http://localhost/api/xremark", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					database: {
						name: "xRemark",
						version: 1,
						backupID: "backup_route",
						backupTime: 1_752_499_800_000,
					},
					remarks: [
						{
							identifier: "42",
							additionalName: "ada",
							remark: "Investor",
						},
					],
				}),
			}),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			imported: true,
			annotationCount: 1,
			backupId: "backup_route",
		});

		const lookup = await GET({
			request: new Request(
				"http://localhost/api/xremark?handle=renamed&identifier=profile_user_42",
			),
		});
		expect(await lookup.json()).toMatchObject({
			annotation: { identifier: "42", remark: "Investor" },
		});

		const older = await POST({
			request: new Request("http://localhost/api/xremark", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					database: {
						name: "xRemark",
						version: 1,
						backupID: "backup_older",
						backupTime: 1_752_499_799_999,
					},
					remarks: [],
				}),
			}),
		});
		expect(older.status).toBe(409);
		expect(await older.json()).toMatchObject({
			message: expect.stringMatching(/older/),
		});
	});

	it("rejects unrelated or oversized backup payloads", async () => {
		const invalid = await POST({
			request: new Request("http://localhost/api/xremark", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ hello: "world" }),
			}),
		});
		expect(invalid.status).toBe(400);
		const malformed = await POST({
			request: new Request("http://localhost/api/xremark", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "not-json",
			}),
		});
		expect(malformed.status).toBe(400);

		const oversized = await POST({
			request: new Request("http://localhost/api/xremark", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"content-length": String(26 * 1024 * 1024),
				},
				body: "{}",
			}),
		});
		expect(oversized.status).toBe(413);

		const chunk = new Uint8Array(13 * 1024 * 1024);
		let chunkCount = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (chunkCount >= 2) {
					controller.close();
					return;
				}
				chunkCount += 1;
				controller.enqueue(chunk);
			},
		});
		const streamedOversized = await POST({
			request: new Request("http://localhost/api/xremark", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: stream,
				duplex: "half",
			} as RequestInit & { duplex: "half" }),
		});
		expect(streamedOversized.status).toBe(413);
	});
});
