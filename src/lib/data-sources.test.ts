// @vitest-environment node
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	localRows: [] as Array<Record<string, unknown>>,
	profileSource: "local",
	twitterConfig: { tokenDetected: false, tokenEnv: "TWITTER_TOKEN" },
	twitterRuntime: {} as Record<string, unknown>,
	bird: vi.fn(),
	transport: vi.fn(),
	oauthAccounts: vi.fn(),
	authenticated: vi.fn(),
}));

vi.mock("./db", () => ({
	getNativeDb: () => ({
		prepare: () => ({ all: () => mocks.localRows }),
	}),
}));
vi.mock("./bird", () => ({
	getAuthenticatedBirdAccountEffect: () => mocks.bird(),
}));
vi.mock("./config", () => ({
	getTwitter6551Config: () => mocks.twitterConfig,
	resolveProfileAnalysisSource: () => mocks.profileSource,
}));
vi.mock("./twitter-6551", () => ({
	getTwitter6551RuntimeStatus: () => mocks.twitterRuntime,
}));
vi.mock("./xurl", () => ({
	getTransportStatusEffect: () => mocks.transport(),
	readXurlOAuth2AccountsEffect: () => mocks.oauthAccounts(),
	lookupAuthenticatedOAuth2UserEffect: () => mocks.authenticated(),
}));

import { getLiveDataSourcesEffect } from "./data-sources";

function runtime(overrides: Record<string, unknown> = {}) {
	return {
		activeSource: "none",
		connected: false,
		lastBackfillAt: null,
		state: "idle",
		lastError: null,
		watchUsers: [],
		...overrides,
	};
}

beforeEach(() => {
	mocks.localRows = [];
	mocks.profileSource = "local";
	mocks.twitterConfig = { tokenDetected: false, tokenEnv: "TWITTER_TOKEN" };
	mocks.twitterRuntime = runtime();
	mocks.bird
		.mockReset()
		.mockReturnValue(Effect.fail(new Error("bird unavailable")));
	mocks.transport.mockReset().mockReturnValue(
		Effect.succeed({
			availableTransport: "none",
			installed: false,
			statusText: "xurl unavailable",
		}),
	);
	mocks.oauthAccounts.mockReset().mockReturnValue(Effect.succeed([]));
	mocks.authenticated.mockReset().mockReturnValue(Effect.succeed(null));
});

describe("live data source status", () => {
	it("reports local, bird, and xurl accounts with deterministic deduplication", async () => {
		mocks.localRows = [
			{ id: "acct-a", handle: "@alice", external_user_id: "1", is_default: 1 },
			{ id: "acct-b", handle: "bob", external_user_id: null, is_default: 0 },
		];
		mocks.bird.mockReturnValue(
			Effect.succeed({ id: "9", username: "bird_user" }),
		);
		mocks.transport.mockReturnValue(
			Effect.succeed({
				availableTransport: "xurl",
				installed: true,
				statusText: "ready",
			}),
		);
		mocks.authenticated.mockReturnValue(
			Effect.succeed({ id: "7", username: "oauth_user" }),
		);
		mocks.oauthAccounts.mockReturnValue(
			Effect.succeed([
				{ id: "7", username: "oauth_user", handle: "@oauth_user" },
				{ id: "8", app: "second", handle: "@other" },
			]),
		);
		const result = await Effect.runPromise(getLiveDataSourcesEffect());
		expect(result.sources[0]).toMatchObject({
			works: true,
			detail: "2 local accounts",
			accounts: [
				{ id: "1", username: "alice", isDefault: true },
				{ id: "acct-b", username: "bob", isDefault: false },
			],
		});
		expect(result.sources[1]).toMatchObject({
			works: true,
			detail: "authenticated as @bird_user",
		});
		expect(result.sources[2]).toMatchObject({ works: true, status: "ok" });
		expect(result.sources[2]?.accounts).toHaveLength(2);
	});

	it("reports empty local state and normalizes incomplete authenticated users", async () => {
		mocks.bird.mockReturnValue(Effect.succeed({ username: "no_id" }));
		mocks.authenticated.mockReturnValue(Effect.succeed({ id: 7, username: 8 }));
		const result = await Effect.runPromise(getLiveDataSourcesEffect());
		expect(result.sources[0]?.detail).toBe(
			"local database ready; no accounts imported yet",
		);
		expect(result.sources[1]?.accounts[0]).toEqual({
			username: "no_id",
			handle: "@no_id",
		});
		expect(result.sources[2]).toMatchObject({
			works: false,
			status: "warning",
			accounts: [{}],
		});
	});

	it("converts bird and xurl failures into source-local errors", async () => {
		mocks.bird.mockReturnValue(Effect.fail("bird exploded"));
		mocks.transport.mockReturnValue(Effect.fail(new Error("xurl exploded")));
		const result = await Effect.runPromise(getLiveDataSourcesEffect());
		expect(result.sources[1]).toMatchObject({
			works: false,
			status: "error",
			detail: "bird exploded",
		});
		expect(result.sources[2]).toMatchObject({
			works: false,
			status: "error",
			detail: "xurl exploded",
		});
	});

	it.each([
		[
			"local",
			runtime({ activeSource: "local" }),
			"local bridge online; 6551 is standing by",
			"ok",
		],
		[
			"xurl",
			runtime({ connected: true, watchUsers: ["one"] }),
			"6551 realtime connected; 1 watched account",
			"ok",
		],
		[
			"6551",
			runtime({ connected: true, watchUsers: ["one", "two"] }),
			"6551 realtime connected; 2 watched accounts",
			"ok",
		],
		[
			"local",
			runtime({ activeSource: "waiting" }),
			"waiting for the local bridge before 6551 takeover",
			"warning",
		],
	] as const)(
		"describes %s profile routing and 6551 runtime variants",
		async (profileSource, twitterRuntime, detail, status) => {
			mocks.profileSource = profileSource;
			mocks.twitterRuntime = twitterRuntime;
			const result = await Effect.runPromise(getLiveDataSourcesEffect());
			expect(result.sources[3]).toMatchObject({ detail, status });
			const capability = result.capabilities.find(
				(item) => item.key === "profile-analysis",
			);
			expect(capability?.primary).toBe(
				profileSource === "6551"
					? "twitter6551"
					: profileSource === "xurl"
						? "xurl"
						: "birdclaw",
			);
		},
	);

	it("describes recovery, token errors, and missing-token 6551 states", async () => {
		mocks.twitterRuntime = runtime({
			lastBackfillAt: "2026-08-10T00:00:00.000Z",
			state: "error",
		});
		let result = await Effect.runPromise(getLiveDataSourcesEffect());
		expect(result.sources[3]).toMatchObject({
			works: false,
			status: "error",
			detail:
				"6551 recovery polling active; last sync 2026-08-10T00:00:00.000Z",
		});
		mocks.twitterConfig.tokenDetected = true;
		mocks.twitterRuntime = runtime({ state: "error", lastError: "bad token" });
		result = await Effect.runPromise(getLiveDataSourcesEffect());
		expect(result.sources[3]).toMatchObject({
			status: "error",
			detail: "bad token",
		});
		mocks.twitterRuntime = runtime({ state: "idle", lastError: null });
		result = await Effect.runPromise(getLiveDataSourcesEffect());
		expect(result.sources[3]?.detail).toBe(
			"token detected; worker is not connected",
		);
		mocks.twitterConfig.tokenDetected = false;
		result = await Effect.runPromise(getLiveDataSourcesEffect());
		expect(result.sources[3]?.detail).toBe("TWITTER_TOKEN not detected");
	});
});
