// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "#/lib/config";
import { getNativeDb, resetDatabaseForTests } from "#/lib/db";
import { createTwillotCompanionPairing } from "#/lib/twillot-companion";
import { enqueueTwillotHistoryJob } from "#/lib/twillot-history-queue";
import { getRouteHandler } from "#/test/route-handlers";
import {
	Route,
	TWILLOT_EXTENSION_ORIGIN,
} from "./integrations.twillot-history";

const GET = getRouteHandler(Route, "GET");
const POST = getRouteHandler(Route, "POST");
const OPTIONS = getRouteHandler(Route, "OPTIONS" as never);
const tempRoots: string[] = [];

beforeEach(() => {
	const root = mkdtempSync(path.join(os.tmpdir(), "birdclaw-twillot-bridge-"));
	tempRoots.push(root);
	process.env.BIRDCLAW_HOME = root;
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
});

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function setup() {
	const db = getNativeDb({ seedDemoData: false });
	db.prepare(
		`insert into accounts (
		   id, name, handle, external_user_id, transport, is_default, created_at
		 ) values ('acct', 'Owner', 'owner', '1', 'xurl', 1, ?)`,
	).run("2026-08-10T00:00:00.000Z");
	const job = enqueueTwillotHistoryJob(db, {
		accountId: "acct",
		profileId: "profile_user_42",
		externalUserId: "42",
		handle: "target",
		now: new Date(Date.now() - 1_000),
	});
	const token = createTwillotCompanionPairing(db).token;
	return { db, job, token };
}

function headers(token: string) {
	return {
		origin: TWILLOT_EXTENSION_ORIGIN,
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
	};
}

describe("Twillot extension bridge API", () => {
	it("answers trusted preflight and rejects forwarded preflight", async () => {
		const allowed = await OPTIONS({
			request: new Request(
				"http://localhost:3001/api/integrations/twillot-history",
				{ method: "OPTIONS", headers: { origin: TWILLOT_EXTENSION_ORIGIN } },
			),
		});
		expect(allowed.status).toBe(204);
		expect(allowed.headers.get("access-control-allow-origin")).toBe(
			TWILLOT_EXTENSION_ORIGIN,
		);
		const denied = await OPTIONS({
			request: new Request(
				"http://localhost:3001/api/integrations/twillot-history",
				{
					method: "OPTIONS",
					headers: {
						origin: TWILLOT_EXTENSION_ORIGIN,
						forwarded: "for=203.0.113.2",
					},
				},
			),
		});
		expect(denied.status).toBe(403);
	});

	it("rejects remote or forwarded requests before reading a pairing token", async () => {
		const { token } = setup();
		const remote = await GET({
			request: new Request(
				"https://birdclaw.example/api/integrations/twillot-history?sourceId=source_12345678",
				{ headers: headers(token) },
			),
		});
		expect(remote.status).toBe(403);

		const forwarded = await GET({
			request: new Request(
				"http://127.0.0.1:3001/api/integrations/twillot-history?sourceId=source_12345678",
				{ headers: { ...headers(token), "x-forwarded-for": "203.0.113.8" } },
			),
		});
		expect(forwarded.status).toBe(403);
	});

	it("rejects missing credentials and malformed claim parameters", async () => {
		const { token } = setup();
		const missing = await GET({
			request: new Request(
				"http://127.0.0.1:3001/api/integrations/twillot-history?sourceId=source_12345678",
				{ headers: { origin: TWILLOT_EXTENSION_ORIGIN } },
			),
		});
		expect(missing.status).toBe(401);
		const malformed = await GET({
			request: new Request(
				"http://127.0.0.1:3001/api/integrations/twillot-history?sourceId=x&requestedCap=501",
				{ headers: headers(token) },
			),
		});
		expect(malformed.status).toBe(400);
		const unauthorizedPost = await POST({
			request: new Request(
				"http://127.0.0.1:3001/api/integrations/twillot-history",
				{
					method: "POST",
					headers: {
						origin: TWILLOT_EXTENSION_ORIGIN,
						"content-type": "application/json",
					},
					body: "{}",
				},
			),
		});
		expect(unauthorizedPost.status).toBe(401);
	});

	it("rejects a second companion source without leaking another lease", async () => {
		const { token } = setup();
		const first = await GET({
			request: new Request(
				"http://127.0.0.1:3001/api/integrations/twillot-history?sourceId=source_12345678",
				{ headers: headers(token) },
			),
		});
		expect(first.status).toBe(200);
		const conflict = await GET({
			request: new Request(
				"http://127.0.0.1:3001/api/integrations/twillot-history?sourceId=source_87654321",
				{ headers: headers(token) },
			),
		});
		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toMatchObject({
			ok: false,
			code: "SOURCE_CONFLICT",
		});
	});

	it("rejects another extension origin before reading a pairing token", async () => {
		const { token } = setup();
		const response = await GET({
			request: new Request(
				"http://127.0.0.1:3001/api/integrations/twillot-history?sourceId=source_12345678",
				{
					headers: {
						...headers(token),
						origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
					},
				},
			),
		});
		expect(response.status).toBe(403);
	});

	it("claims a job and imports a bounded public-post batch", async () => {
		const { db, job, token } = setup();
		const claimResponse = await GET({
			request: new Request(
				"http://127.0.0.1:3001/api/integrations/twillot-history?sourceId=source_12345678",
				{ headers: headers(token) },
			),
		});
		const claim = (await claimResponse.json()) as {
			job: { id: string; leaseToken: string };
		};
		expect(claim.job.id).toBe(job.id);

		const batchResponse = await POST({
			request: new Request(
				"http://127.0.0.1:3001/api/integrations/twillot-history",
				{
					method: "POST",
					headers: headers(token),
					body: JSON.stringify({
						action: "batch",
						sourceId: "source_12345678",
						jobId: job.id,
						leaseToken: claim.job.leaseToken,
						batchId: "batch-bridge-0001",
						records: [
							{
								id: "101",
								tweet_id: "101",
								user_id: "42",
								category_name: "public-post",
								created_at: "2025-01-01T00:00:00.000Z",
								full_text: "history from Twillot",
								screen_name: "target",
							},
						],
						cursor: { tweetId: "101" },
						done: true,
						lastSyncTime: "2026-08-10T01:02:00.000Z",
					}),
				},
			),
		});
		expect(batchResponse.status).toBe(200);
		expect(await batchResponse.json()).toMatchObject({
			ok: true,
			completeness: "caught_up_unverified",
		});
		expect(
			db.prepare("select text from tweets where id = '101'").get(),
		).toEqual({ text: "history from Twillot" });
	});

	it("rejects non-whitelisted row fields and returns stale-lease codes", async () => {
		const { job, token } = setup();
		const claimResponse = await GET({
			request: new Request(
				"http://127.0.0.1:3001/api/integrations/twillot-history?sourceId=source_12345678",
				{ headers: headers(token) },
			),
		});
		const claim = (await claimResponse.json()) as {
			job: { leaseToken: string };
		};
		const base = {
			action: "batch",
			sourceId: "source_12345678",
			jobId: job.id,
			leaseToken: claim.job.leaseToken,
			batchId: "batch-strict-0001",
			records: [
				{
					id: "102",
					user_id: "42",
					category_name: "public-post",
					created_at: "2025-01-01T00:00:00.000Z",
					full_text: "strict row",
					screen_name: "target",
					forbidden_private_field: "must not cross the bridge",
				},
			],
			done: false,
		};
		const strict = await POST({
			request: new Request(
				"http://127.0.0.1:3001/api/integrations/twillot-history",
				{
					method: "POST",
					headers: headers(token),
					body: JSON.stringify(base),
				},
			),
		});
		expect(strict.status).toBe(400);

		const compositeId = await POST({
			request: new Request(
				"http://127.0.0.1:3001/api/integrations/twillot-history",
				{
					method: "POST",
					headers: headers(token),
					body: JSON.stringify({
						...base,
						batchId: "batch-composite-id-0001",
						records: [
							{
								id: "101_42_public-post",
								user_id: "42",
								category_name: "public-post",
								created_at: "2025-01-01T00:00:00.000Z",
								full_text: "must fail closed",
								screen_name: "target",
							},
						],
					}),
				},
			),
		});
		expect(compositeId.status).toBe(400);

		const stale = await POST({
			request: new Request(
				"http://127.0.0.1:3001/api/integrations/twillot-history",
				{
					method: "POST",
					headers: headers(token),
					body: JSON.stringify({
						...base,
						leaseToken: "00000000-0000-4000-8000-000000000000",
						batchId: "batch-stale-0001",
						records: [],
					}),
				},
			),
		});
		expect(stale.status).toBe(409);
		expect(await stale.json()).toMatchObject({
			ok: false,
			code: "STALE_LEASE",
		});
	});

	it("rejects oversized, missing, malformed, and schema-invalid POST bodies", async () => {
		const { token } = setup();
		const oversized = await POST({
			request: new Request(
				"http://127.0.0.1:3001/api/integrations/twillot-history",
				{
					method: "POST",
					headers: { ...headers(token), "content-length": "16777217" },
					body: "{}",
				},
			),
		});
		expect(oversized.status).toBe(413);
		const missing = await POST({
			request: new Request(
				"http://127.0.0.1:3001/api/integrations/twillot-history",
				{ method: "POST", headers: headers(token) },
			),
		});
		expect(missing.status).toBe(400);
		const malformed = await POST({
			request: new Request(
				"http://127.0.0.1:3001/api/integrations/twillot-history",
				{ method: "POST", headers: headers(token), body: "{" },
			),
		});
		expect(malformed.status).toBe(400);
		const schemaInvalid = await POST({
			request: new Request(
				"http://127.0.0.1:3001/api/integrations/twillot-history",
				{ method: "POST", headers: headers(token), body: "{}" },
			),
		});
		expect(schemaInvalid.status).toBe(400);
		const streamedOversized = await POST({
			request: new Request(
				"http://127.0.0.1:3001/api/integrations/twillot-history",
				{
					method: "POST",
					headers: headers(token),
					body: "x".repeat(16 * 1024 * 1024 + 1),
				},
			),
		});
		expect(streamedOversized.status).toBe(413);
	});
});
