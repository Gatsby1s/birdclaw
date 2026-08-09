import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";

const mocks = vi.hoisted(() => ({
	maybeAutoUpdateBackup: vi.fn(),
	getQueryEnvelope: vi.fn(),
}));

vi.mock("#/lib/backup", () => ({
	maybeAutoUpdateBackup: mocks.maybeAutoUpdateBackup,
	maybeAutoUpdateBackupEffect: () =>
		Effect.promise(() => Promise.resolve(mocks.maybeAutoUpdateBackup())),
}));

vi.mock("#/lib/query-status", () => ({
	getQueryEnvelope: mocks.getQueryEnvelope,
	getQueryEnvelopeEffect: () =>
		Effect.promise(() => Promise.resolve(mocks.getQueryEnvelope())),
}));

import { Route } from "./status";

const GET = getRouteHandler(Route, "GET");

describe("status api route", () => {
	beforeEach(() => {
		vi.stubEnv("BIRDCLAW_LOCAL_BRIDGE_TOKEN", "");
		vi.stubEnv("BIRDCLAW_CLOUD_BRIDGE_URL", "");
		vi.stubEnv("BIRDCLAW_CLOUD_BRIDGE_TOKEN", "");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("returns the query envelope as json", async () => {
		mocks.maybeAutoUpdateBackup.mockResolvedValue(undefined);
		mocks.getQueryEnvelope.mockResolvedValue({
			stats: { home: 4, mentions: 2, dms: 4, needsReply: 2, inbox: 4 },
			accounts: [
				{
					id: "acct_primary",
					name: "Primary",
					handle: "@primary",
					transport: "xurl",
					isDefault: 1,
					createdAt: "2026-06-15T12:00:00.000Z",
				},
			],
			archives: [
				{
					path: "/tmp/archive.zip",
					name: "archive.zip",
					size: 1024,
					sizeFormatted: "1 KB",
					modifiedTime: "2026-06-15T12:00:00.000Z",
					dateFormatted: "Jun 15, 2026",
				},
			],
			transport: {
				installed: true,
				availableTransport: "xurl",
				statusText: "xurl available",
			},
		});

		const response = await GET({
			request: new Request("http://localhost/api/status"),
		});

		await expect(response.json()).resolves.toEqual({
			bookmarkSyncMode: "manual",
			stats: { home: 4, mentions: 2, dms: 4, needsReply: 2, inbox: 4 },
			accounts: [
				{
					id: "acct_primary",
					name: "Primary",
					handle: "@primary",
					transport: "xurl",
					isDefault: 1,
					createdAt: "2026-06-15T12:00:00.000Z",
				},
			],
			archives: [
				{
					path: "/tmp/archive.zip",
					name: "archive.zip",
					size: 1024,
					sizeFormatted: "1 KB",
					modifiedTime: "2026-06-15T12:00:00.000Z",
					dateFormatted: "Jun 15, 2026",
				},
			],
			transport: {
				installed: true,
				availableTransport: "xurl",
				statusText: "xurl available",
			},
		});
		expect(mocks.maybeAutoUpdateBackup).toHaveBeenCalledTimes(1);
		expect(response.headers.get("content-type")).toBe("application/json");
	});

	it("returns automatic bookmark sync mode from the query envelope", async () => {
		mocks.maybeAutoUpdateBackup.mockResolvedValue(undefined);
		mocks.getQueryEnvelope.mockResolvedValue({
			bookmarkSyncMode: "automatic",
			stats: { home: 0, mentions: 0, dms: 0, needsReply: 0, inbox: 0 },
			accounts: [],
			archives: [],
			transport: {
				installed: false,
				availableTransport: "local",
				statusText: "local",
			},
		});

		const response = await GET({
			request: new Request("https://birdclaw.example/api/status"),
		});

		await expect(response.json()).resolves.toMatchObject({
			bookmarkSyncMode: "automatic",
		});
	});
});
